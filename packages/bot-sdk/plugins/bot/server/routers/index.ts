import { eventIterator } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "../../../../core/server/procedures";
import { rpcError } from "../../../../core/server/rpc-error";
import {
  botMessages,
  createBot,
  findBot,
  latestTurnStatus,
  listBots,
  userTurnStatus,
} from "../store";
import { botSendEventSchema } from "../../shared/turn";
import { turnProvenance } from "../provenance";
import {
  approveRoutine,
  declineRoutine,
  listRoutines,
  pauseRoutine,
  removeRoutine,
  resumeRoutine,
  rotateWebhook,
} from "../routine";
import { cancelCheckIn, listCheckIns } from "../check-in";
import { listHelpers } from "../helper-card";
import { helperDone } from "../hand-off";
import { stopHelpers } from "../helper-tools";
import { isTimeZone } from "../time-zone";
import { sendToBot, stopBot } from "../turn";

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
      return createBot(context.sdk.db, context.user.id, input, context.sdk.clock());
    }),

  /** The caller's Bots, the newest activity first, with their last sent Message and Turn status. */
  list: protectedProcedure.handler(({ context }) => listBots(context.sdk.db, context.user.id)),

  /**
   * One of the caller's Bots with its latest Turn's status and the status of the Turn that took the
   * user's last Message, its Conversation's Messages, and its Turns' provenance; another user's is
   * not found.
   */
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
      // Each Turn's Triggers and whether it sent anything, for the dividers of Routine runs.
      const [turns, userStatus] = await Promise.all([
        turnProvenance(context.sdk.db, bot.id, messages),
        userTurnStatus(context.sdk.db, messages),
      ]);
      return { bot: { ...bot, turnStatus, userTurnStatus: userStatus }, messages, turns };
    }),

  /**
   * Sends the caller's Message to their Bot and follows the Turn that takes it, which runs as a
   * runner job: the saved user Message, each Message sent after it, then `turnEnded`. A send while
   * a Turn runs waits in the Conversation queue for the next Turn. `id` is the client's uuidv7 for
   * the Message: a resend with the same `id` saves nothing new and re-joins the same Turn's stream. A disconnect ends only the
   * follow, never the Turn.
   */
  send: protectedProcedure
    .input(
      z.object({
        botId: z.uuid(),
        // Lowercased, as the Trigger's text id holds it, so an uppercase resend still re-joins.
        id: z.uuidv7().transform((id) => id.toLowerCase()),
        text: z.string().trim().min(1),
        // The client's IANA zone; the Turn's newest input shows the time in it (UTC when absent).
        timeZone: z.string().refine(isTimeZone, "Not an IANA time zone").optional(),
      }),
    )
    .output(eventIterator(botSendEventSchema))
    .handler(({ context, input, signal }) =>
      sendToBot(context.sdk, { userId: context.user.id, ...input, signal }),
    ),

  /**
   * Stops the caller's Bot's running Turn: a queued one ends `stopped` at once, a running one as
   * its attempt aborts. The Messages already sent stay. Does nothing when no Turn is running.
   */
  stop: protectedProcedure
    .input(z.object({ botId: z.uuid() }))
    .handler(({ context, input }) => stopBot(context.sdk, context.user.id, input.botId)),

  /** The Routines of the caller's Bots (#538). Approving or declining one never wakes the Bot. */
  routine: {
    /** One of the caller's Bots' Routines, sorted by name, each with the Message its card follows. */
    list: protectedProcedure
      .input(z.object({ botId: z.uuid() }))
      .handler(async ({ context, input }) => {
        const found = await findBot(context.sdk.db, context.user.id, input.botId);
        if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
        return listRoutines(context.sdk.db, input.botId);
      }),

    /** Approves a pending Routine: it turns `active`. Another user's is not found. */
    approve: protectedProcedure
      .input(z.object({ routineId: z.uuid() }))
      .handler(({ context, input }) =>
        approveRoutine(context.sdk, context.user.id, input.routineId),
      ),

    /** Declines a pending Routine, which deletes it. Another user's is not found. */
    decline: protectedProcedure
      .input(z.object({ routineId: z.uuid() }))
      .handler(({ context, input }) =>
        declineRoutine(context.sdk.db, context.user.id, input.routineId),
      ),

    /**
     * Pauses an active Routine: its queued fire is cancelled and its Triggers no Turn has taken yet
     * are dropped. Another user's is not found.
     */
    pause: protectedProcedure
      .input(z.object({ routineId: z.uuid() }))
      .handler(({ context, input }) => pauseRoutine(context.sdk, context.user.id, input.routineId)),

    /** Resumes a paused Routine with no fresh OK: its next fire is queued. Another user's is not found. */
    resume: protectedProcedure
      .input(z.object({ routineId: z.uuid() }))
      .handler(({ context, input }) =>
        resumeRoutine(context.sdk, context.user.id, input.routineId),
      ),

    /** Deletes a Routine in any state, and nothing of it fires again. Another user's is not found. */
    delete: protectedProcedure
      .input(z.object({ routineId: z.uuid() }))
      .handler(({ context, input }) =>
        removeRoutine(context.sdk, context.user.id, input.routineId),
      ),

    /**
     * Gives an approved webhook Routine a new URL (ADR 0021): the new token comes back this once, and
     * the old URL answers 404 from then on. Another user's is not found.
     */
    rotate: protectedProcedure
      .input(z.object({ routineId: z.uuid() }))
      .handler(({ context, input }) =>
        rotateWebhook(context.sdk, context.user.id, input.routineId),
      ),
  },

  /** The Check-ins of the caller's Bots (#540). */
  checkIn: {
    /** One of the caller's Bots' Check-ins, soonest first, each with the Message its line follows. */
    list: protectedProcedure
      .input(z.object({ botId: z.uuid() }))
      .handler(async ({ context, input }) => {
        const found = await findBot(context.sdk.db, context.user.id, input.botId);
        if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
        return listCheckIns(context.sdk.db, input.botId);
      }),

    /** Cancels a pending Check-in: it never fires. Another user's is not found. */
    cancel: protectedProcedure
      .input(z.object({ checkInId: z.uuid() }))
      .handler(({ context, input }) =>
        cancelCheckIn(context.sdk, context.user.id, input.checkInId),
      ),
  },

  /** The Helpers of the caller's Bots (#590). */
  helper: {
    /** One of the caller's Bots' Helpers, oldest first, each with the Message its card follows. */
    list: protectedProcedure
      .input(z.object({ botId: z.uuid() }))
      .handler(async ({ context, input }) => {
        const found = await findBot(context.sdk.db, context.user.id, input.botId);
        if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
        return listHelpers(context.sdk.db, input.botId);
      }),

    /**
     * The user's Done on a Helper waiting for them at a hand-off (#568): it goes back to running and
     * a fresh job carries on from where it stopped, and its Computer card reads done. Refused,
     * "This task was stopped.", once it isn't waiting. Another user's Helper is not found.
     */
    done: protectedProcedure
      .input(z.object({ helperId: z.uuid() }))
      .handler(({ context, input }) => helperDone(context.sdk, context.user.id, input.helperId)),

    /**
     * Stops one of the caller's Bot's Helpers, or all of its live ones with no `helperId`, as
     * `stop_helpers` does: no `helper` Trigger. One that already ended, or isn't the Bot's, stays
     * as it is. Another user's Bot is not found.
     */
    stop: protectedProcedure
      .input(z.object({ botId: z.uuid(), helperId: z.uuid().optional() }))
      .handler(async ({ context, input }) => {
        const found = await findBot(context.sdk.db, context.user.id, input.botId);
        if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
        await context.sdk.db.transaction((tx) =>
          stopHelpers(context.sdk, tx, input.botId, input.helperId),
        );
      }),
  },
};

/** The `bot` plugin's routers, served under `<basePath>/rpc/<key>`. */
export const botPluginRouter = { bot: botRouter };
export type BotRouter = typeof botPluginRouter;
