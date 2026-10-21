import { eq } from "drizzle-orm";

import { decryptCredentials } from "../../../core/server/credentials/encryption";
import { botSecret } from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";

/** What a masked value is replaced with in a result the Model reads. */
export const maskedValue = "***";

/** Binds a Secret's ciphertext to its row, so a row copied elsewhere won't decrypt. */
export const secretEncryption = (
  sdk: Pick<BotSdkContext, "keyring">,
  userId: string,
  name: string,
) => ({
  secrets: sdk.keyring,
  kind: "secret" as const,
  context: `${userId}:secret:${name}`,
});

/** Every Secret of the user, decrypted, by name. A row no key can read is left out. */
export async function loadSecretValues(
  sdk: Pick<BotSdkContext, "db" | "keyring">,
  userId: string,
): Promise<Map<string, string>> {
  const rows = await sdk.db
    .select({ name: botSecret.name, encrypted: botSecret.encrypted })
    .from(botSecret)
    .where(eq(botSecret.userId, userId));
  const values = new Map<string, string>();
  for (const row of rows) {
    const result = decryptCredentials(row.encrypted, secretEncryption(sdk, userId, row.name));
    if (result.ok && result.credentials.value) values.set(row.name, result.credentials.value);
  }
  return values;
}

/** What a `shell` call that names a Secret the user doesn't have gets back. */
export function unknownSecretError(unknown: string[], known: Iterable<string>): string {
  const names = [...known];
  return (
    `No Secret named ${unknown.join(", ")}. ` +
    (names.length > 0
      ? `The user's Secrets are: ${names.join(", ")}.`
      : "The user has no Secrets: ask for one with send_to_user.")
  );
}

/** The forms of a Secret's value that are masked: itself, its base64 and its URL-encoded form. */
export function maskedForms(value: string): string[] {
  return [value, Buffer.from(value, "utf8").toString("base64"), encodeURIComponent(value)].filter(
    (form) => form.length > 0,
  );
}

/** Every form of `values` that is masked, the longest first. */
export function maskedFormsOf(values: Iterable<string>): string[] {
  return [...new Set([...values].flatMap(maskedForms))].sort((a, b) => b.length - a.length);
}

/**
 * `text` with every value of the user's Secrets, and its base64 and URL-encoded forms, replaced
 * with `***`. It reads the whole text, so a value split across output chunks is found; call it
 * before the output is cut down to its ends. The longest forms go first, so one that contains
 * another is replaced whole.
 */
export function maskSecrets(text: string, values: Iterable<string>): string {
  const forms = maskedFormsOf(values);
  let masked = text;
  for (const form of forms) masked = masked.split(form).join(maskedValue);
  return masked;
}

/** `maskSecrets` over every string of a JSON-like result (a `read` result's lines, a hint). */
export function maskResult<T>(result: T, values: Iterable<string>): T {
  const list = [...values];
  if (list.length === 0) return result;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return maskSecrets(node, list);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(result) as T;
}
