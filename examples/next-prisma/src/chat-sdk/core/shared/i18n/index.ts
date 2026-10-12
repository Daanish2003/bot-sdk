import { en } from "./en";

export { en };

/** Every key the Chat SDK shows, with its English text. A Host's dictionary is a partial `Messages`. */
export type Messages = typeof en;
export type MessageKey = keyof Messages;

/** The params a key's function takes. A plain string key takes none. */
export type MessageParams<K extends MessageKey> = Messages[K] extends (params: infer P) => string
  ? P
  : never;

/** The text for a key, with its params. */
export type Translate = <K extends MessageKey>(key: K, params?: MessageParams<K>) => string;

/** What the UI and the client core read: the text for a key, and the locale to format with. */
export type I18n = { locale: string; t: Translate };

/**
 * A translator over a Host's partial dictionary. A key the Host leaves out (or sets to `undefined`)
 * falls back to English; an unknown key shows as itself.
 */
export function createI18n(messages: Partial<Messages> = {}, locale = "en"): I18n {
  const t: Translate = (key, params) => {
    const entry = (messages[key] ?? en[key]) as string | ((params: unknown) => string) | undefined;
    if (entry === undefined) return key;
    return typeof entry === "string" ? entry : entry(params);
  };
  return { locale, t };
}
