import { z } from "zod";

import { protectedProcedure } from "../../../../core/server/procedures";
import { rpcError } from "../../../../core/server/rpc-error";
import { botMessages, createBot, findBot, listBots } from "../store";

const botRouter = {
  /**
   * Creates a Bot on one of the caller's Models (`models.list`), with an empty Conversation. A Bot
   * doesn't greet: its Conversation starts with no Message.
   */
  create: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100), model: z.string() }))
    .handler(async ({ context, input }) => {
      const { models } = await context.sdk.plugin("models").listAvailableModels(context.user.id);
      if (!models.some((model) => model.id === input.model)) {
        throw rpcError(
          "BAD_REQUEST",
          "error.modelNotAvailable",
          `"${input.model}" is not an available Model`,
          { model: input.model },
        );
      }
      return createBot(context.sdk.db, context.user.id, input);
    }),

  /** The caller's Bots, the newest activity first. */
  list: protectedProcedure.handler(({ context }) => listBots(context.sdk.db, context.user.id)),

  /** One of the caller's Bots and its Conversation's Messages; another user's is not found. */
  get: protectedProcedure
    .input(z.object({ botId: z.uuid() }))
    .handler(async ({ context, input }) => {
      const found = await findBot(context.sdk.db, context.user.id, input.botId);
      if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      const { conversationId, ...bot } = found;
      return { bot, messages: await botMessages(context.sdk.db, conversationId) };
    }),
};

/** The `bot` plugin's routers, served under `<basePath>/rpc/<key>`. */
export const botPluginRouter = { bot: botRouter };
export type BotRouter = typeof botPluginRouter;
