import type { BotSdkPlugin } from "../../../core/server/plugin";

export type KnowledgePlugin = BotSdkPlugin<"knowledge", never, never>;

/**
 * The `knowledge` plugin (spec #737): Knowledge as plain files on the Computer. For now it holds
 * the text extraction (`extract.ts`) that the assistant's Project Knowledge also imports. It uses
 * `computer` when the Host enables it (a soft dependency).
 */
export function knowledge(): KnowledgePlugin {
  return { id: "knowledge", uses: ["computer"] };
}
