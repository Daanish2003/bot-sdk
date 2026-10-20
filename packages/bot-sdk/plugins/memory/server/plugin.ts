import { asc, eq } from "drizzle-orm";

import { memory as memoryTable, memorySettings } from "../../../core/server/db/schema";
import type { BotSdkContext, BotSdkPlugin, Transaction } from "../../../core/server/plugin";
import type { TurnChange } from "../shared/changes";
import { botMemorySnapshot, type BotSnapshotArgs } from "./bot-memory";
import { enqueueMemories, type MakeMemoriesPayload } from "./make";
import { memoryEnabledFor } from "./manage";
import { turnChangesOf } from "./notice";
import { recalledMemoriesPrompt } from "./recall";
import { memoryRouter } from "./routers/index";

/** One Memory as the user's export holds it, valid or outdated. */
export type ExportedMemory = {
  id: string;
  text: string;
  origin: "extracted" | "said";
  conversationId: string;
  replacedById: string | null;
  /** When the Memory was outdated; null while it is valid. */
  invalidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The `memory` plugin's API (`sdk.plugin("memory")`): what the assistant calls to recall and make
 * Memories (ADR 0013), and the user's Memory switch, which covers the assistant and the Bots.
 */
export type MemoryApi = {
  /**
   * The Memories block of an assistant Run's system prompts, or `null` when the Run recalls none:
   * in a Temporary Conversation, with the user's Memory off, or with no Memories in scope.
   */
  recallPrompt: (args: {
    userId: string;
    /** The Run's Conversation's Project, which scopes the Memories; null for a general one. */
    projectId: string | null;
    /** Whether the Run's Conversation is a Temporary Conversation. */
    temporary: boolean;
    /** The latest user Message's text, which the similar Memories are found by. */
    latestText: string | null;
  }) => Promise<string | null>;
  /** Queues the Memory job for an assistant Run that ended `complete` or `stopped`, when it may run. */
  afterRun: (args: MakeMemoriesPayload) => Promise<void>;
  /** The user's Memory switch: on for a user who never saved it. */
  isEnabled: (userId: string) => Promise<boolean>;
  /** What each turn changed, by the user Message's id, for the replies' "Memory updated" chips (#290). */
  turnChanges: (userMessageIds: string[]) => Promise<Map<string, TurnChange[]>>;
  /**
   * The memory block of Bot `botId`'s Turn (ADR 0022), read from the user's Computer as of `now`,
   * waking it: the Profiles, the top Log lines, the recent Notes and the rules. Null with the
   * user's Memory off. A Computer failure throws.
   */
  botSnapshot: (args: BotSnapshotArgs) => Promise<string | null>;
  /** The user's switch and every Memory, valid and outdated, read in the export's snapshot `tx`. */
  exportRows: (
    tx: Transaction,
    userId: string,
  ) => Promise<{ enabled: boolean; memories: ExportedMemory[] }>;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    memory: MemoryApi;
  }
}

export type MemoryPlugin = BotSdkPlugin<"memory", never, never>;

/**
 * The `memory` plugin (ADR 0013, its #616 amendment): the assistant's Memories, their jobs, the
 * Memory page's router and the user's Memory switch. A Host turns Memory off by leaving it out.
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
        await tx.delete(memoryTable).where(eq(memoryTable.userId, userId));
        await tx.delete(memorySettings).where(eq(memorySettings.userId, userId));
      },
      after: async () => {},
    },
  };
}

function memoryApi(sdk: BotSdkContext): MemoryApi {
  return {
    recallPrompt: (args) => recalledMemoriesPrompt(sdk, args),
    afterRun: (payload) => enqueueMemories(sdk, payload),
    isEnabled: (userId) => memoryEnabledFor(sdk, userId),
    turnChanges: (userMessageIds) => turnChangesOf(sdk, userMessageIds),
    botSnapshot: (args) => botMemorySnapshot(sdk, args),
    exportRows: async (tx, userId) => ({
      enabled: await memoryEnabledFor({ db: tx }, userId),
      memories: await tx
        .select({
          id: memoryTable.id,
          text: memoryTable.text,
          origin: memoryTable.origin,
          conversationId: memoryTable.conversationId,
          replacedById: memoryTable.replacedById,
          invalidAt: memoryTable.invalidAt,
          createdAt: memoryTable.createdAt,
          updatedAt: memoryTable.updatedAt,
        })
        .from(memoryTable)
        .where(eq(memoryTable.userId, userId))
        .orderBy(asc(memoryTable.createdAt), asc(memoryTable.id)),
    }),
  };
}
