import { eq } from "drizzle-orm";

import { memorySettings } from "../../../core/server/db/schema";
import type { BotSdkContext, BotSdkPlugin, Transaction } from "../../../core/server/plugin";
import type { ComputerHandle } from "../../computer/server/plugin";
import { botMemorySnapshot, botsOf, exportBotMemory, type BotSnapshotArgs } from "./bot-memory";
import { enqueueBotMemoryPass } from "./bot-pass";
import { memoryEnabledFor } from "./manage";
import { memoryRouter } from "./routers/index";
import { type MemoryHit, searchBotMemory } from "./search";

/**
 * The `memory` plugin's API (`sdk.plugin("memory")`): the Bots' file memory (ADR 0022) and the
 * user's Memory switch.
 */
export type MemoryApi = {
  /** The user's Memory switch: on for a user who never saved it. */
  isEnabled: (userId: string) => Promise<boolean>;
  /**
   * The memory block of Bot `botId`'s Turn (ADR 0022), read from the user's Computer as of `now`,
   * waking it: the Profiles, the top Log lines, the recent Notes and the rules. Null with the
   * user's Memory off. A Computer failure throws.
   */
  botSnapshot: (args: BotSnapshotArgs) => Promise<string | null>;
  /**
   * Queues Turn `turnId`'s post-turn pass (ADR 0022) in `tx`, the transaction that ends it, when it
   * ended `complete` or `stopped` and the user's Memory is on with a `computer` plugin. Call the
   * runner's `wake()` once `tx` has committed.
   */
  afterTurn: (tx: Transaction, turnId: string) => Promise<void>;
  /**
   * Searches Bot `botId`'s memory for `query` as of `now` (ADR 0022): its own files and every
   * Bot's Profile, ranked by BM25 x importance x decay, the top 10. A Computer failure throws.
   */
  searchBotMemory: (args: {
    userId: string;
    botId: string;
    query: string;
    now: Date;
    computer: ComputerHandle;
    signal?: AbortSignal;
  }) => Promise<MemoryHit[]>;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    memory: MemoryApi;
  }
}

export type MemoryPlugin = BotSdkPlugin<"memory", never, never>;

/**
 * The `memory` plugin (ADR 0022): the Bots' file memory, its post-turn pass, the Memory routers
 * and the user's Memory switch. A Host turns Memory off by leaving it out.
 */
export function memory(): MemoryPlugin {
  return {
    id: "memory",
    requires: ["models", "runner"],
    uses: ["computer"],
    router: { memory: memoryRouter },
    init: (sdk) => ({ api: memoryApi(sdk) }),
    deleteUser: {
      before: async (_sdk, { userId, tx }) => {
        await tx.delete(memorySettings).where(eq(memorySettings.userId, userId));
      },
      after: async () => {},
    },
    exportUser: async (sdk, userId, tx) => ({
      memoryEnabled: await memoryEnabledFor({ db: tx }, userId),
      botMemory: await exportBotMemory(sdk, tx, userId),
    }),
  };
}

function memoryApi(sdk: BotSdkContext): MemoryApi {
  return {
    isEnabled: (userId) => memoryEnabledFor(sdk, userId),
    botSnapshot: (args) => botMemorySnapshot(sdk, args),
    afterTurn: (tx, turnId) => enqueueBotMemoryPass(sdk, tx, turnId),
    searchBotMemory: async ({ userId, botId, query, now, computer, signal }) =>
      searchBotMemory(computer, { botId, bots: await botsOf(sdk, userId), query, now, signal }),
  };
}
