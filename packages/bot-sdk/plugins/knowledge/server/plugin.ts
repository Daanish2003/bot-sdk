import type { BotSdkPlugin } from "../../../core/server/plugin";
import { knowledgeRouter } from "./routers/index";

export type KnowledgePlugin = BotSdkPlugin<"knowledge", never, never>;

/**
 * The `knowledge` plugin (spec #737): a user's Knowledge as plain files in `shared/knowledge/` on
 * their Computer, with the routes that list, read, upload, delete and make folders. It also holds
 * the text extraction (`extract.ts`) that the assistant's Project Knowledge imports. It uses
 * `computer`: without it, the routes refuse and there is no Knowledge. It doesn't follow the
 * user's Memory switch.
 */
export function knowledge(): KnowledgePlugin {
  return { id: "knowledge", uses: ["computer"], router: { knowledgeFiles: knowledgeRouter } };
}
