import type { ChatgptAccessToken } from "@ai-chat/auth/chatgpt";
import type { LinkedCredentialsHook } from "@botsdk/bot/models";

/**
 * The models plugin's `linkedCredentials` hook (ADR 0023): the user's linked ChatGPT plan as
 * OpenAI's `apiKey`, nothing when ChatGPT is not linked, `"needs-reconnect"` when its token can't be
 * refreshed. `tokenFor` reads Better Auth through apps/web's own database pool, never the SDK's
 * connection, so a hook asked inside an SDK transaction can't wait on it.
 */
export function linkedCredentialsOf(
  tokenFor: (userId: string) => Promise<ChatgptAccessToken>,
): LinkedCredentialsHook {
  return async (userId, service) => {
    if (service !== "openai") return null;
    const token = await tokenFor(userId);
    if (token.status === "ok") return { apiKey: token.accessToken };
    return token.status === "needs-reconnect" ? "needs-reconnect" : null;
  };
}

/** A cached token is dropped this long before it expires. */
const EXPIRY_MARGIN_MS = 30_000;
/**
 * A cached token lives this long at most. Disconnecting ChatGPT happens in the browser against
 * Better Auth, out of this hook's reach, so the cap bounds how long a token outlives its link.
 */
const MAX_AGE_MS = 60_000;

/**
 * `tokenFor` with one in-flight request per user and a short per-user cache of a good token: a Run
 * asks for the token on every Model call, and each uncached ask is a database read and, near expiry,
 * a refresh against ChatGPT. A missing or broken link is never cached, so linking takes effect at once.
 */
export function cachedTokenFor(
  tokenFor: (userId: string) => Promise<ChatgptAccessToken>,
  now: () => number = Date.now,
): (userId: string) => Promise<ChatgptAccessToken> {
  const cached = new Map<string, { token: ChatgptAccessToken; until: number }>();
  const inFlight = new Map<string, Promise<ChatgptAccessToken>>();
  return (userId) => {
    const hit = cached.get(userId);
    if (hit && now() < hit.until) return Promise.resolve(hit.token);
    const pending = inFlight.get(userId);
    if (pending) return pending;
    const request = tokenFor(userId)
      .then((token) => {
        if (token.status === "ok" && token.expiresAt) {
          const until = Math.min(token.expiresAt.getTime() - EXPIRY_MARGIN_MS, now() + MAX_AGE_MS);
          cached.set(userId, { token, until });
        } else {
          cached.delete(userId);
        }
        return token;
      })
      .finally(() => inFlight.delete(userId));
    inFlight.set(userId, request);
    return request;
  };
}
