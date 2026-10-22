import type { BotSdkClientPlugin } from "../../../core/client/plugin";
import type { KnowledgeRouter } from "../server/routers/index";

declare module "../../../core/client/plugin" {
  interface PluginRouters {
    knowledgeFiles: KnowledgeRouter;
  }
}

export type KnowledgeClientPlugin = BotSdkClientPlugin<"knowledge", KnowledgeRouter>;

/** The `knowledge` plugin's client: its router is `knowledgeFiles` (`knowledge` is the assistant's until its Project Knowledge is removed). It adds no URLs. */
export function knowledgeClient(): KnowledgeClientPlugin {
  return { id: "knowledge" };
}
