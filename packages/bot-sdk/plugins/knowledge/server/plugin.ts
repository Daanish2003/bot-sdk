import type { BotSdkPlugin } from "../../../core/server/plugin";
import type { ComputerHandle } from "../../computer/server/plugin";
import { knowledgePrompt, readKnowledgePaths } from "./prompt";
import { knowledgeRouter } from "./routers/index";

/** The `knowledge` plugin's API (`sdk.plugin("knowledge")`): the readable paths and the block. */
export type KnowledgeApi = {
  /**
   * The readable paths of the user's Knowledge on `computer`, waking it: relative to the Knowledge
   * folder, sorted, a converted file by its `.md` copy. A Computer failure throws.
   */
  readablePaths: (args: { computer: ComputerHandle; signal?: AbortSignal }) => Promise<string[]>;
  /** The Knowledge block of a Bot's Prompt start, listing `paths`. */
  prompt: (paths: string[]) => string;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    knowledge: KnowledgeApi;
  }
}

export type KnowledgePlugin = BotSdkPlugin<"knowledge", never, never>;

/**
 * The `knowledge` plugin (spec #737): a user's Knowledge as plain files in `shared/knowledge/` on
 * their Computer, with the routes that list, read, upload, delete and make folders, and the
 * Knowledge block every Bot of the user sees. It uses `computer`: without it, the routes refuse
 * and there is no Knowledge. It doesn't follow the user's Memory switch.
 */
export function knowledge(): KnowledgePlugin {
  return {
    id: "knowledge",
    uses: ["computer"],
    router: { knowledge: knowledgeRouter },
    init: () => ({
      api: {
        readablePaths: ({ computer, signal }) => readKnowledgePaths(computer, { signal }),
        prompt: knowledgePrompt,
      } satisfies KnowledgeApi,
    }),
  };
}
