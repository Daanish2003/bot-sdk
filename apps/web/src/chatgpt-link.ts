import type { LinkedCredentialsHook } from "@ai-chat/bot-sdk/plugins/models/server";

/** "Connect ChatGPT" is on only when both CHATGPT_* settings are set (the same test the auth link uses). */
export function chatgptLinkEnabled(env: {
  CHATGPT_CLIENT_ID?: string;
  CHATGPT_HOST_ID?: string;
}): boolean {
  return Boolean(env.CHATGPT_CLIENT_ID && env.CHATGPT_HOST_ID);
}

/** The models plugin's `linkedCredentials` option: the hook when the link is on, nothing otherwise. */
export function linkedCredentialsHook(
  env: { CHATGPT_CLIENT_ID?: string; CHATGPT_HOST_ID?: string },
  hook: LinkedCredentialsHook,
): { linkedCredentials?: LinkedCredentialsHook } {
  return chatgptLinkEnabled(env) ? { linkedCredentials: hook } : {};
}
