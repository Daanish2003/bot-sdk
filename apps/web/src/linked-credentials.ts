import type { ChatgptAccessToken } from "@ai-chat/auth/chatgpt";
import type { LinkedCredentialsHook } from "@ai-chat/bot-sdk/plugins/models/server";

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
