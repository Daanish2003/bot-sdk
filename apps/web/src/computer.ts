import type { ComputerProvider } from "@ai-chat/bot-sdk/plugins/computer/server";

/** The self-hosted E2B a Host points the Computers at (spec #519). */
export type E2bConfig = { apiKey: string; apiUrl: string; sandboxUrl: string };

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
