import {
  createBotInput,
  botInput,
  sendInput,
  uploadInput,
  chooseInput,
  reactInput,
} from "@botsdk/client/bot/contract";

import { lastSeqOf } from "../../../core/server/chat/change-log";
import type { BotSdkContext } from "../../../core/server/plugin";
import { parseInput, rpcError, type WithUser } from "../../../core/server/rpc-error";
import {
  botMessages,
  createBot,
  findBot,
  latestTurnStatus,
  listBots,
  uploadBotFile,
  userTurnStatus,
} from "./conversation";
import { turnProvenance } from "./safety";
import { botSummaries, botWarmings, warmBot } from "./context";
import { sendToBot, stopBot } from "./turn";
import { answerChoice, reactToMessage } from "./triggers";

/*
 * The `bots` namespace's domain methods (spec #873): what a Host calls in-process, with the user's
 * id and no request. Each takes one object with `userId`, and its input schema is the contract's
 * (`shared/contract.ts`), so an in-process call is held to the rules an HTTP call is.
 */

/** The `bots` namespace over the core context. */
export function botsApi(sdk: BotSdkContext) {
  return {
    /**
     * Creates a Bot on one of the user's Models (`models.list`), with an empty Conversation. A Bot
     * doesn't greet: its Conversation starts with no Message.
     */
    create: async ({ userId, ...rest }: WithUser<typeof createBotInput>) => {
      const input = parseInput(createBotInput, rest);
      const { models } = await sdk.models.listAvailableModels(userId);
      if (!models.some((model) => model.id === input.model)) {
        throw rpcError(
          "BAD_REQUEST",
          "error.modelNotAvailable",
          `"${input.model}" is not an available Model`,
          { model: input.model },
        );
      }
      return createBot(sdk.db, userId, input, sdk.clock());
    },

    /** The user's Bots, the newest activity first, with their last sent Message and Turn status. */
    list: async ({ userId }: { userId: string }) => listBots(sdk.db, userId),

    /**
     * One of the user's Bots with its latest Turn's status and the status of the Turn that took the
     * user's last Message, its Conversation's id and Messages, its Turns' provenance, its Summaries
     * and its cache warmings, and `lastSeq`, the cursor to follow its thread with
     * `conversations.changes` from; another user's is not found.
     */
    get: async ({ userId, ...rest }: WithUser<typeof botInput>) => {
      const { botId } = parseInput(botInput, rest);
      const found = await findBot(sdk.db, userId, botId);
      if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      const { conversationId, ...bot } = found;
      // Read before the thread, so no change committed meanwhile falls behind the cursor.
      const lastSeq = await lastSeqOf(sdk.db, conversationId);
      const [messages, turnStatus] = await Promise.all([
        botMessages(sdk.db, conversationId),
        latestTurnStatus(sdk.db, bot.id),
      ]);
      // Each Turn's Triggers and whether it sent anything, for the dividers of Routine runs.
      const [turns, userStatus, summaries, warmings] = await Promise.all([
        turnProvenance(sdk.db, userId, bot.id, messages),
        userTurnStatus(sdk.db, messages),
        botSummaries(sdk.db, bot.id, conversationId),
        botWarmings(sdk, userId, bot.id),
      ]);
      return {
        bot: { ...bot, turnStatus, userTurnStatus: userStatus },
        conversationId,
        messages,
        turns,
        summaries,
        warmings,
        lastSeq,
      };
    },

    /**
     * Sends the user's Message to their Bot and returns the saved user Message. The Turn that takes
     * it runs as a runner job; every tab follows it through `conversations.changes` (ADR 0026). A
     * send while a Turn runs waits in the Conversation queue for the next Turn. `id` is the
     * caller's uuidv7 for the Message: a resend with the same `id` saves nothing new and returns
     * the Message saved first. `files` are ids from `upload`: the Message carries them as its
     * `files` part, and the Turn that takes it copies them onto the Bot's Computer. With files, the
     * text may be empty.
     */
    send: async ({ userId, ...rest }: WithUser<typeof sendInput>) =>
      sendToBot(sdk, { userId, ...parseInput(sendInput, rest) }),

    /**
     * Stores a file the user will send their Bot, of any type up to 25 MB, and returns its id for
     * `send`'s `files`. One no Message sends is deleted after 24 hours. Rate-limited over HTTP
     * only, like attachments.
     */
    upload: async ({ userId, ...rest }: WithUser<typeof uploadInput>) =>
      uploadBotFile(sdk, userId, parseInput(uploadInput, rest).file),

    /**
     * Stops the user's Bot's running Turn: a queued one ends `stopped` at once, a running one as
     * its attempt aborts. The Messages already sent stay. Does nothing when no Turn is running.
     */
    stop: async ({ userId, ...rest }: WithUser<typeof botInput>) =>
      stopBot(sdk, userId, parseInput(botInput, rest).botId),

    /**
     * Warms the cache of the user's Bot (slide 32). It does nothing while a Turn runs, while the
     * cache is still warm, or for a Model with no warming call; `skipped` says which. Another
     * user's Bot is not found.
     */
    warm: async ({ userId, ...rest }: WithUser<typeof botInput>) =>
      warmBot(sdk, userId, parseInput(botInput, rest).botId),

    /**
     * Answers the choice a Bot asked in Message `messageId` (spec #761): an `option` or the free
     * text of `other`. It wakes the Bot with one Trigger, even if the Bot has moved on. The first
     * answer wins; a later one is refused as answered. Another user's Bot is not found.
     */
    choose: async ({ userId, ...rest }: WithUser<typeof chooseInput>) =>
      answerChoice(sdk, userId, parseInput(chooseInput, rest)),

    /**
     * Puts the user's emoji on a Bot reply, replacing their earlier one, or takes it off with a null
     * `emoji` (spec #761). A state change only: it wakes no Turn. Another user's Bot is not found.
     */
    react: async ({ userId, ...rest }: WithUser<typeof reactInput>) =>
      reactToMessage(sdk, userId, parseInput(reactInput, rest)),
  };
}

/** The `bots` namespace's domain methods. */
export type BotsApi = ReturnType<typeof botsApi>;
