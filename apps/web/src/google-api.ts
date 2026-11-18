import { ConnectionBrokenError } from "@botsdk/mcp";

/**
 * Calls one of Google's REST APIs as the user, with a Connection's access token, and answers the
 * JSON body. A token Google refuses throws a `ConnectionBrokenError`, so the Bot is told to have
 * the user reconnect (ADR 0037): HTTP 401, which is also what a revoked grant answers, and a token
 * missing a scope the user unticked at consent, which linking again asks for. Any other failure
 * throws Google's own message, which is the call's answer.
 */
export async function googleApi(
  fetch: typeof globalThis.fetch,
  app: string,
  accessToken: string,
  url: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: init.signal,
  });
  const body = (await response.json().catch(() => undefined)) as GoogleError | undefined;
  if (response.ok) return body;
  const error = body?.error;
  const scopeMissing = error?.details?.some(
    (detail) => detail.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  );
  if (response.status === 401 || scopeMissing) {
    throw new ConnectionBrokenError(`${app} refused the Connection's token`);
  }
  throw new Error(
    `${app} answered HTTP ${response.status}${error?.message ? `: ${error.message}` : ""}`,
  );
}

/** Google's APIs' error body. */
type GoogleError = {
  error?: { code?: number; status?: string; message?: string; details?: { reason?: string }[] };
};
