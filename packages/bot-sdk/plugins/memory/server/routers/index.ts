import { z } from "zod";

import {
  addBotLine,
  deleteBotLine,
  editBotLine,
  listBotMemory,
  readBotFile,
  saveBotFile,
} from "../bot-lines";
import { memoryStatus, setMemoryEnabled } from "../manage";
import { protectedProcedure } from "../../../../core/server/procedures";

const fileInput = z.object({
  botId: z.string(),
  tier: z.enum(["profile", "log", "notes"]),
  /** The Log file's month, `YYYY-MM`; a Log file needs it. */
  month: z.string().optional(),
});

/** The Memory procedures: the switch and the Bots' memory files (ADR 0022). A Host without the `memory` plugin has none, and the page is hidden. */
export const memoryRouter = {
  /** The user's switch, and whether Bots can have memory. */
  status: protectedProcedure.handler(({ context }) => memoryStatus(context.sdk, context.user.id)),

  /** Bot `botId`'s memory lines by tier, each with whether its Turn holds it now (ADR 0022). */
  botList: protectedProcedure.input(z.object({ botId: z.string() })).handler(({ context, input }) =>
    listBotMemory(context.sdk, {
      userId: context.user.id,
      botId: input.botId,
      now: context.sdk.clock(),
    }),
  ),

  /** Changes one line of a file of the user's Bots; refused when it no longer reads `current`. */
  botEditLine: protectedProcedure
    .input(
      z.object({
        file: fileInput,
        line: z.number().int().positive(),
        current: z.string(),
        text: z.string(),
      }),
    )
    .handler(async ({ context, input }) => {
      await editBotLine(context.sdk, { userId: context.user.id, ...input });
    }),

  /** Deletes one line of a file of the user's Bots; refused when it no longer reads `current`. */
  botDeleteLine: protectedProcedure
    .input(z.object({ file: fileInput, line: z.number().int().positive(), current: z.string() }))
    .handler(async ({ context, input }) => {
      await deleteBotLine(context.sdk, { userId: context.user.id, ...input });
    }),

  /** Adds a line to a Bot's Profile, to this month's Log or to its Notes. */
  botAddLine: protectedProcedure
    .input(
      z.object({
        botId: z.string(),
        tier: z.enum(["profile", "log", "notes"]),
        text: z.string(),
      }),
    )
    .handler(async ({ context, input }) => {
      await addBotLine(context.sdk, { userId: context.user.id, ...input });
    }),

  /** A Bot memory file's raw text. */
  botReadFile: protectedProcedure
    .input(z.object({ file: fileInput }))
    .handler(async ({ context, input }) => ({
      content: await readBotFile(context.sdk, { userId: context.user.id, file: input.file }),
    })),

  /** Saves a Bot memory file whole; refused when it no longer reads `expected`. */
  botSaveFile: protectedProcedure
    .input(z.object({ file: fileInput, expected: z.string(), content: z.string() }))
    .handler(async ({ context, input }) => {
      await saveBotFile(context.sdk, { userId: context.user.id, ...input });
    }),

  /** Turns the "Use and make Memories" switch on or off. */
  setEnabled: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .handler(async ({ context, input }) => {
      await setMemoryEnabled(context.sdk, context.user.id, input.enabled);
    }),
};

/** The `memory` plugin's routers, by key. */
export type MemoryRouter = { memory: typeof memoryRouter };
