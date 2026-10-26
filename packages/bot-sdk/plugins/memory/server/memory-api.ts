import { z } from "zod";

import type { BotSdkContext } from "../../../core/server/plugin";
import { parseInput } from "../../../core/server/rpc-error";
import {
  addBotLine,
  deleteBotLine,
  editBotLine,
  listBotMemory,
  readBotFile,
  saveBotFile,
} from "./bot-lines";
import { memoryEnabledFor, memoryStatus, setMemoryEnabled } from "./manage";

/*
 * The `memory` namespace's domain methods (spec #873): what a Host calls in-process as
 * `sdk.memory`, with the user's id and no request. The procedures of `routers/index.ts` are
 * one-line wrappers that pass the signed-in user's id, validating with the same schemas.
 */

const fileInput = z.object({
  botId: z.string(),
  tier: z.enum(["profile", "log", "notes"]),
  /** The Log file's month, `YYYY-MM`; a Log file needs it. */
  month: z.string().optional(),
});

/** `memory.botList`'s input, besides `userId`. */
export const botListInput = z.object({ botId: z.string() });

/** `memory.botEditLine`'s input, besides `userId`. */
export const botEditLineInput = z.object({
  file: fileInput,
  line: z.number().int().positive(),
  current: z.string(),
  text: z.string(),
});

/** `memory.botDeleteLine`'s input, besides `userId`. */
export const botDeleteLineInput = z.object({
  file: fileInput,
  line: z.number().int().positive(),
  current: z.string(),
});

/** `memory.botAddLine`'s input, besides `userId`. */
export const botAddLineInput = z.object({
  botId: z.string(),
  tier: z.enum(["profile", "log", "notes"]),
  text: z.string(),
});

/** `memory.botReadFile`'s input, besides `userId`. */
export const botReadFileInput = z.object({ file: fileInput });

/** `memory.botSaveFile`'s input, besides `userId`. */
export const botSaveFileInput = z.object({
  file: fileInput,
  expected: z.string(),
  content: z.string(),
});

/** `memory.setEnabled`'s input, besides `userId`. */
export const setEnabledInput = z.object({ enabled: z.boolean() });

type WithUser<Schema extends z.ZodType> = { userId: string } & z.input<Schema>;

/** The `memory` namespace over the core context. */
export function memoryApi(sdk: BotSdkContext) {
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
