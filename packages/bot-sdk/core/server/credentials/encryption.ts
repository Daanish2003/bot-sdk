import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

import type { Credentials } from "../deps";

/** Provider credentials, Tool credentials and Connection tokens each get their own key (ADR 0010). */
export type CredentialKind = "provider" | "tool" | "connection";

type Options = {
  /** `keyEncryptionSecrets`: the first encrypts, every entry decrypts. Never empty. */
  secrets: readonly string[];
  kind: CredentialKind;
  /** Binds the ciphertext to its row (`userId:service`), so a row copied elsewhere won't decrypt. */
  context: string;
};

export type DecryptResult =
  | { ok: true; credentials: Credentials }
  /** `unknown-key`: no key of the keyring matches the row's `kid`. `corrupt`: anything else. */
  | { ok: false; reason: "unknown-key" | "corrupt" };

const VERSION = "v2";
const ALGORITHM = "aes-256-gcm";
/** Full-length tags only: Node would otherwise accept a truncated tag on decrypt. */
const AUTH_TAG_LENGTH = 16;
const KID_LENGTH = 8;

const kindInfo: Record<CredentialKind, string> = {
  provider: "ai-chat provider credentials",
  tool: "ai-chat tool credentials",
  connection: "ai-chat connection tokens",
};

/** The AES key for `kind` derived from one secret, and its `kid`: a short HMAC of that key. */
function deriveKey(secret: string, kind: CredentialKind) {
  const key = Buffer.from(hkdfSync("sha256", secret, "", kindInfo[kind], 32));
  const kid = createHmac("sha256", key)
    .update("ai-chat kid")
    .digest("base64url")
    .slice(0, KID_LENGTH);
  return { key, kid };
}

/** Encrypts with AES-256-GCM under the first secret, as `v2.<kid>.<iv>.<tag>.<ciphertext>` (ADR 0010). */
export function encryptCredentials(
  credentials: Credentials,
  { secrets, kind, context }: Options,
): string {
  const [first] = secrets;
  if (first === undefined) throw new Error("The keyring holds no secret");
  const { key, kid } = deriveKey(first, kind);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return [VERSION, kid, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/** The `kid` of the key `kind` encrypts under now: the first secret's. */
export function encryptionKid(secrets: readonly string[], kind: CredentialKind): string {
  const [first] = secrets;
  if (first === undefined) throw new Error("The keyring holds no secret");
  return deriveKey(first, kind).kid;
}

/** The `kid` a `v2` ciphertext names, or `undefined` for anything else. */
export function kidOf(encrypted: string): string | undefined {
  const [version, kid] = encrypted.split(".");
  return version === VERSION ? kid : undefined;
}

/** Decrypts `encryptCredentials` output with the keyring, trying only the key the `kid` names. */
export function decryptCredentials(
  encrypted: string,
  { secrets, kind, context }: Options,
): DecryptResult {
  const [version, kid, iv, tag, ciphertext, ...rest] = encrypted.split(".");
  if (version !== VERSION || !kid || !iv || !tag || !ciphertext || rest.length > 0) {
    return { ok: false, reason: "corrupt" };
  }
  const match = secrets
    .map((secret) => deriveKey(secret, kind))
    .find((derived) => derived.kid === kid);
  if (!match) return { ok: false, reason: "unknown-key" };
  try {
    const decipher = createDecipheriv(ALGORITHM, match.key, Buffer.from(iv, "base64url"), {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return { ok: true, credentials: JSON.parse(plaintext) as Credentials };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}
