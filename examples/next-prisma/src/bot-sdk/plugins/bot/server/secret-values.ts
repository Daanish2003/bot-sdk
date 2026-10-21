import { eq } from "drizzle-orm";

import { decryptCredentials } from "../../../core/server/credentials/encryption";
import { botSecret } from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";

/** What a masked value is replaced with in a result the Model reads. */
export const maskedValue = "***";

/** A Secret shorter than this, once trimmed, is refused and never masked: it would mask ordinary text. */
export const minSecretLength = 4;

/** The form of a Secret's value that is stored and masked: trimmed, or undefined when too short. */
export function usableSecretValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length >= minSecretLength ? trimmed : undefined;
}

/** The Trigger text that wakes the Bot once the user saved Secret `name`: the name, never the value. */
export const savedSecretText = (name: string) => `Saved secret ${name}`;

/** Whether a Trigger's text is a saved Secret's wake notice (`savedSecretText`). */
export const isSavedSecretText = (text: string | null) =>
  text !== null && /^Saved secret \S+$/.test(text);

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

/** What a loop has decrypted, by a row's name and ciphertext: a re-saved Secret is a new entry. */
export type DecryptedSecrets = Map<string, string | undefined>;

/**
 * Every Secret of the user, decrypted, by name. A row no key can read is left out. The rows are
 * read each time, so a Secret saved meanwhile is in; with `decrypted`, a row seen before isn't
 * decrypted again.
 */
export async function loadSecretValues(
  sdk: Pick<BotSdkContext, "db" | "keyring">,
  userId: string,
  decrypted: DecryptedSecrets = new Map(),
): Promise<Map<string, string>> {
  const rows = await sdk.db
    .select({ name: botSecret.name, encrypted: botSecret.encrypted })
    .from(botSecret)
    .where(eq(botSecret.userId, userId));
  const values = new Map<string, string>();
  for (const row of rows) {
    const key = `${row.name}:${row.encrypted}`;
    if (!decrypted.has(key)) {
      const result = decryptCredentials(row.encrypted, secretEncryption(sdk, userId, row.name));
      decrypted.set(key, result.ok ? usableSecretValue(result.credentials.value ?? "") : undefined);
    }
    const value = decrypted.get(key);
    if (value) values.set(row.name, value);
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

/** A masked form of a Secret's value, and whether it may be wrapped across lines (base64's). */
type MaskedForm = { text: string; wraps: boolean };

const base64Of = (text: string) => Buffer.from(text, "utf8").toString("base64");

/**
 * The forms of a Secret's value that are masked: itself, its base64, the base64 of it followed by a
 * newline (what `echo $KEY | base64` prints) and its URL-encoded form.
 */
function formsOf(value: string): MaskedForm[] {
  return [
    { text: value, wraps: false },
    { text: base64Of(value), wraps: true },
    { text: base64Of(`${value}\n`), wraps: true },
    { text: encodeURIComponent(value), wraps: false },
  ].filter((form) => form.text.length > 0);
}

/** Every form of `values` that is masked, the longest first. */
function allFormsOf(values: Iterable<string>): MaskedForm[] {
  const byText = new Map([...values].flatMap(formsOf).map((form) => [form.text, form]));
  return [...byText.values()].sort((a, b) => b.text.length - a.text.length);
}

/** How many columns GNU `base64` prints a line of. */
const base64Columns = 76;

/**
 * Every form of `values` that is masked, the longest first, as the Computer's `redact` takes
 * them: plain strings, so a base64 form long enough to wrap is also given wrapped at 76 columns.
 */
export function maskedFormsOf(values: Iterable<string>): string[] {
  const texts = allFormsOf(values).flatMap((form) =>
    form.wraps && form.text.length > base64Columns
      ? [form.text, (form.text.match(/.{1,76}/g) ?? []).join("\n")]
      : [form.text],
  );
  return [...new Set(texts)].sort((a, b) => b.length - a.length);
}

/** The masker of no Secrets: it changes nothing. */
const unmasked = (text: string) => text;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What masks `values` in a text, built once for many texts: each value, and its base64 and
 * URL-encoded forms, becomes `***`. A base64 form also matches when wrapped across lines, as GNU
 * `base64` wraps at 76 columns. The longest forms go first, so one that contains another is
 * replaced whole.
 */
export function secretMasker(values: Iterable<string>): (text: string) => string {
  const forms = allFormsOf(values);
  if (forms.length === 0) return unmasked;
  const pattern = new RegExp(
    forms
      .map((form) =>
        form.wraps ? [...form.text].map(escaped).join("(?:\\r?\\n)?") : escaped(form.text),
      )
      .join("|"),
    "g",
  );
  return (text) => text.replace(pattern, maskedValue);
}

/**
 * `text` with every value of the user's Secrets, and its base64 and URL-encoded forms, replaced
 * with `***` (`secretMasker`). It reads the whole text, so a value split across output chunks is
 * found; call it before the output is cut down to its ends.
 */
export function maskSecrets(text: string, values: Iterable<string>): string {
  return secretMasker(values)(text);
}

/** `mask` (a `secretMasker`) over every string of a JSON-like result (a `read` result's lines, a hint). */
export function maskResult<T>(result: T, mask: (text: string) => string): T {
  if (mask === unmasked) return result;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return mask(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(result) as T;
}
