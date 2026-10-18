import { type ComputerPlugin, computer } from "@ai-chat/bot-sdk/plugins/computer/server";

/** The self-hosted E2B a Host points the Computers at (spec #519). */
export type E2bConfig = { apiKey: string; apiUrl: string; sandboxUrl: string };

/**
 * The `computer` plugin on self-hosted E2B, or none when E2B is unset. The E2B adapter (and the
 * `e2b` SDK under it) loads only when Computers are on, so it stays out of the boot path otherwise
 * (spec #519, ticket #560).
 */
export async function computerPluginsOf(
  e2b: E2bConfig | undefined,
  template: string,
): Promise<ComputerPlugin[]> {
  if (!e2b) return [];
  const { e2bProvider } = await import("@ai-chat/bot-sdk/plugins/computer/e2b");
  return [computer({ provider: e2bProvider({ ...e2b, template }) })];
}
