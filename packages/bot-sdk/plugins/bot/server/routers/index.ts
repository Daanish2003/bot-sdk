import { eventIterator } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "../../../../core/server/procedures";
import { rpcError } from "../../../../core/server/rpc-error";
import { botMessages, createBot, findBot, latestTurnStatus, listBots } from "../store";
import { botSendEventSchema } from "../../shared/turn";
import { sendToBot } from "../turn";

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

  /** The caller's Bots, the newest activity first, with their last sent Message and Turn status. */
  list: protectedProcedure.handler(({ context }) => listBots(context.sdk.db, context.user.id)),

  /** One of the caller's Bots with its latest Turn's status, and its Conversation's Messages; another user's is not found. */
  get: protectedProcedure
    .input(z.object({ botId: z.uuid() }))
    .handler(async ({ context, input }) => {
      const found = await findBot(context.sdk.db, context.user.id, input.botId);
      if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      const { conversationId, ...bot } = found;
      const [messages, turnStatus] = await Promise.all([
        botMessages(context.sdk.db, conversationId),
        latestTurnStatus(context.sdk.db, bot.id),
      ]);
      return { bot: { ...bot, turnStatus }, messages };
    }),

  /**
   * Sends the caller's Message to their Bot and follows its Turn, which runs as a runner job: the
   * saved user Message, each Message the Bot sends, then `turnEnded`. A disconnect ends only the
   * follow, never the Turn.
   */
  send: protectedProcedure
    .input(z.object({ botId: z.uuid(), text: z.string().trim().min(1) }))
    .output(eventIterator(botSendEventSchema))
    .handler(({ context, input, signal }) =>
      sendToBot(context.sdk, { userId: context.user.id, ...input, signal }),
    ),
};

/** The `bot` plugin's routers, served under `<basePath>/rpc/<key>`. */
export const botPluginRouter = { bot: botRouter };
export type BotRouter = typeof botPluginRouter;
