import type { FeatureContext } from "@botsdk/bot/feature";

import { parseInput, type WithUser } from "@botsdk/bot/rpc-error";
import {
  addBotLine,
  deleteBotLine,
  editBotLine,
  listBotMemory,
  readBotFile,
  saveBotFile,
} from "./bot-lines";
import { memoryEnabledFor, memoryStatus, setMemoryEnabled } from "./manage";
import {
  botAddLineInput,
  botDeleteLineInput,
  botEditLineInput,
  botListInput,
  botReadFileInput,
  botSaveFileInput,
  setEnabledInput,
} from "../shared/contract";

/*
 * The `memory` namespace's domain methods (spec #873): what a Host calls in-process as
 * `sdk.memory`, with the user's id and no request. The HTTP layer serves the
 * feature's contract (`shared/contract.ts`) over them, passing the signed-in user's id.
 */

/** The `memory` namespace over the core context. */
export function memoryApi(sdk: FeatureContext<"computer">) {
  return {
    /** The user's Memory switch: on for a user who never saved it. */
    isEnabled: ({ userId }: { userId: string }) => memoryEnabledFor(sdk, userId),

    /** The user's switch, and whether Bots can have memory. */
    status: ({ userId }: { userId: string }) => memoryStatus(sdk, userId),

    /** Bot `botId`'s memory lines by tier, each with whether its Turn holds it now (ADR 0022). */
    botList: async ({ userId, ...rest }: WithUser<typeof botListInput>) =>
      listBotMemory(sdk, {
        userId,
        botId: parseInput(botListInput, rest).botId,
        now: sdk.clock(),
      }),

    /** Changes one line of a file of the user's Bots; refused when it no longer reads `current`. */
    botEditLine: async ({ userId, ...rest }: WithUser<typeof botEditLineInput>) => {
      await editBotLine(sdk, { userId, ...parseInput(botEditLineInput, rest) });
    },

    /** Deletes one line of a file of the user's Bots; refused when it no longer reads `current`. */
    botDeleteLine: async ({ userId, ...rest }: WithUser<typeof botDeleteLineInput>) => {
      await deleteBotLine(sdk, { userId, ...parseInput(botDeleteLineInput, rest) });
    },

    /** Adds a line to a Bot's Profile, to this month's Log or to its Notes. */
    botAddLine: async ({ userId, ...rest }: WithUser<typeof botAddLineInput>) => {
      await addBotLine(sdk, { userId, ...parseInput(botAddLineInput, rest) });
    },

    /** A Bot memory file's raw text. */
    botReadFile: async ({ userId, ...rest }: WithUser<typeof botReadFileInput>) => ({
      content: await readBotFile(sdk, { userId, file: parseInput(botReadFileInput, rest).file }),
    }),

    /** Saves a Bot memory file whole; refused when it no longer reads `expected`. */
    botSaveFile: async ({ userId, ...rest }: WithUser<typeof botSaveFileInput>) => {
      await saveBotFile(sdk, { userId, ...parseInput(botSaveFileInput, rest) });
    },

    /** Turns the "Use and make Memories" switch on or off. */
    setEnabled: async ({ userId, ...rest }: WithUser<typeof setEnabledInput>) => {
      await setMemoryEnabled(sdk, userId, parseInput(setEnabledInput, rest).enabled);
    },
  };
}

/** The `memory` feature's API (`sdk.memory`). */
export type MemoryApi = ReturnType<typeof memoryApi>;
