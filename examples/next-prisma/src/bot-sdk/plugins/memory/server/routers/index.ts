import { z } from "zod";

import {
  addBotLine,
  deleteBotLine,
  editBotLine,
  listBotMemory,
  readBotFile,
  saveBotFile,
} from "../bot-lines";
import {
  deleteAllMemories,
  deleteMemory,
  editMemory,
  listMemories,
  memoryStatus,
  setMemoryEnabled,
} from "../manage";
import { protectedProcedure } from "../../../../core/server/procedures";
import { rpcError } from "../../../../core/server/rpc-error";

const fileInput = z.object({
  botId: z.string(),
  tier: z.enum(["profile", "log", "notes"]),
  /** The Log file's month, `YYYY-MM`; a Log file needs it. */
  month: z.string().optional(),
});

/** The Memory page's procedures (#289). A Host without the `memory` plugin has none, and the page is hidden. */
export const memoryRouter = {
  /** The user's switch, and whether an embedding Model is there. */
  status: protectedProcedure.handler(({ context }) => memoryStatus(context.sdk, context.user.id)),

  /** The user's valid Memories, grouped General first and then by Project. */
  list: protectedProcedure.handler(async ({ context }) => {
    return { groups: await listMemories(context.sdk, context.user.id) };
  }),

  /** Changes a Memory's text and embeds it again; its source Message is kept. */
  edit: protectedProcedure
    .input(z.object({ id: z.uuid(), text: z.string() }))
    .handler(async ({ context, input }) => {
      const text = input.text.trim();
      if (text === "")
        throw rpcError("BAD_REQUEST", "error.memoryTextBlank", "Text can't be blank");
      await editMemory(context.sdk, context.user.id, input.id, text);
    }),

  /** Hard-deletes one Memory. */
  delete: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      await deleteMemory(context.sdk, context.user.id, input.id);
    }),

  /** Hard-deletes every Memory the user has. */
  deleteAll: protectedProcedure.handler(async ({ context }) => {
    await deleteAllMemories(context.sdk, context.user.id);
  }),

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

  /** Saves a Bot memory file whole. */
  botSaveFile: protectedProcedure
    .input(z.object({ file: fileInput, content: z.string() }))
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
