import { CredentialsRejectedError } from "@botsdk/bot/channel";
import type { MessagingCall } from "@botsdk/bot/channel";

/** Telegram's Bot API host. A Host may point the adapter elsewhere, such as a local Bot API server. */
export const defaultApiBase = "https://api.telegram.org";

/** A failed Bot API call that isn't about the credentials: the core retries it. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    /** Seconds Telegram asks to wait before the next call (a 429), when it says. */
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = "TelegramApiError";
  }
}

type Envelope<Result> = {
  ok: boolean;
  result?: Result;
  description?: string;
  parameters?: { retry_after?: number };
};

/**
 * Calls whose 403 means the token is bad. A 403 on a call about one chat ("bot was blocked by the
 * user") is a delivery error, so one blocked chat never stops the Channel account. This is a
 * deliberate reading of the spec's "401/403 on any call": a 401 is a rejection on any call.
 */
const accountWideMethods = new Set(["getMe", "getUpdates", "deleteWebhook"]);

/**
 * Calls one Bot API method with the SDK's `fetch` (JSON, or multipart when `body` is a
 * `FormData`). A 401 or 403 throws `CredentialsRejectedError`.
 */
export async function callApi<Result>(
  apiBase: string,
  token: string,
  method: string,
  body: Record<string, unknown> | FormData,
  { fetch: fetcher, signal }: MessagingCall,
): Promise<Result> {
  const response = await fetcher(`${apiBase}/bot${token}/${method}`, {
    method: "POST",
    headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
    body: body instanceof FormData ? body : JSON.stringify(body),
    signal,
  });
  const envelope = (await response.json().catch(() => ({}))) as Envelope<Result>;
  if (response.status === 401 || (response.status === 403 && accountWideMethods.has(method))) {
    throw new CredentialsRejectedError(envelope.description ?? response.statusText);
  }
  if (!response.ok || !envelope.ok) {
    throw new TelegramApiError(
      method,
      response.status,
      envelope.description ?? "no description",
      envelope.parameters?.retry_after,
    );
  }
  return envelope.result as Result;
}
