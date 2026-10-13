import { en, type I18n, type MessageKey } from "../shared/i18n";

/** What a server error carries in `data` (spec #256): a dictionary code and its params. */
type ServerErrorData = { code: string; params?: Record<string, unknown> };

function serverErrorData(error: unknown): ServerErrorData | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const { code } = data as { code?: unknown };
  return typeof code === "string" ? (data as ServerErrorData) : null;
}

/** A code the dictionary has text for: an `error.` key, so `time.today` isn't one. */
function isErrorKey(code: string): code is Extract<MessageKey, `error.${string}`> {
  return code.startsWith("error.") && Object.hasOwn(en, code);
}

/** Numbers come from the server as numbers; the text shows them in the locale. */
function formatParams(locale: string, params: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : value,
    ]),
  );
}

/**
 * The text to show for an error from the server: the dictionary's text for its code, with its
 * params. The server's English message is for the logs, so it's never shown. An error with no code
 * a dictionary has (a network failure, or one oRPC raised itself) shows `fallback`.
 */
export function serverErrorText(
  { t, locale }: I18n,
  error: unknown,
  fallback: MessageKey = "error.unexpected",
): string {
  const data = serverErrorData(error);
  if (!data || !isErrorKey(data.code)) return t(fallback);
  const params = formatParams(locale, data.params ?? {});
  return (t as (key: string, params?: unknown) => string)(data.code, params);
}
