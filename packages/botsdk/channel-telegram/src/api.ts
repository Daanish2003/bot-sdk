import { CredentialsRejectedError } from "@botsdk/bot/channel";
import type { MessagingCall } from "@botsdk/bot/channel";

/** Telegram's Bot API host. A Host may point the adapter elsewhere, such as a local Bot API server. */
export const defaultApiBase = "https://api.telegram.org";

/** A failed Bot API call that isn't about the credentials: the core retries it. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    description: string,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = "TelegramApiError";
  }
}

type Envelope<Result> = { ok: boolean; result?: Result; description?: string };

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
  if (response.status === 401 || response.status === 403) {
    throw new CredentialsRejectedError(envelope.description ?? response.statusText);
  }
  if (!response.ok || !envelope.ok) {
    throw new TelegramApiError(method, response.status, envelope.description ?? "no description");
  }
  return envelope.result as Result;
}
