import type { ComputerProvider } from "@ai-chat/bot-sdk/plugins/computer/server";

/** The self-hosted E2B a Host points the Computers at (spec #519). */
export type E2bConfig = { apiKey: string; apiUrl: string; sandboxUrl: string };

/**
 * The Host's E2B config from its env, or none when unset. The three values are set together or not
 * at all, so a typo does not silently turn Computers off.
 */
export function e2bConfigOf(env: {
  E2B_API_KEY?: string;
  E2B_API_URL?: string;
  E2B_SANDBOX_URL?: string;
}): E2bConfig | undefined {
  const values = [env.E2B_API_KEY, env.E2B_API_URL, env.E2B_SANDBOX_URL];
  if (values.some(Boolean) && !values.every(Boolean)) {
    throw new Error("E2B_API_KEY, E2B_API_URL and E2B_SANDBOX_URL are set together or not at all");
  }
  return env.E2B_API_KEY && env.E2B_API_URL && env.E2B_SANDBOX_URL
    ? { apiKey: env.E2B_API_KEY, apiUrl: env.E2B_API_URL, sandboxUrl: env.E2B_SANDBOX_URL }
    : undefined;
}

/**
 * The Computer slot's provider on self-hosted E2B, or none when E2B is unset. The E2B adapter (and
 * the `e2b` SDK under it) loads only when Computers are on, so it stays out of the boot path
 * otherwise (spec #519, ticket #560).
 */
export async function computerProviderOf(
  e2b: E2bConfig | undefined,
  template: string,
): Promise<ComputerProvider | undefined> {
  if (!e2b) return undefined;
  const { e2bProvider } = await import("@ai-chat/bot-sdk/plugins/computer/e2b");
  return e2bProvider({ ...e2b, template });
}
