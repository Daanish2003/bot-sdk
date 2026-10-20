import { z } from "zod";

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

  /** Turns the "Use and make Memories" switch on or off. */
  setEnabled: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .handler(async ({ context, input }) => {
      await setMemoryEnabled(context.sdk, context.user.id, input.enabled);
    }),
};

/** The `memory` plugin's routers, by key. */
export type MemoryRouter = { memory: typeof memoryRouter };
