import { eventIterator } from "@orpc/server";
import { z } from "zod";

import { lastSeqOf } from "../../../../core/server/chat/change-log";
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
import { botChanges } from "../changes";
import { cancelCheckIn, listCheckIns } from "../check-in";
import { listHelpers } from "../helper-card";
import { decideReview, listReviews } from "../review";
import { deleteSecret, listSecrets, saveSecret } from "../secret";
import { secretNameSchema } from "../../shared/secret";
import { helperDone } from "../hand-off";
import { stopBotHelpers } from "../helper-tools";
import { screenControl, screenView } from "../screen-view";
import type { DemonstrationAction } from "../../shared/demonstration";
import { actOnDemonstration } from "../demonstration";
import { demonstrationSteps } from "../demonstration-capture";
import { botSummaries } from "../summary";
import { isTimeZone } from "../time-zone";
import { sendToBot, stopBot } from "../turn";
import { botWarmings, warmBot } from "../warm";

/** A route that applies `action` to one of the caller's Demonstrations. */
const demonstrationAction = (action: DemonstrationAction) =>
  protectedProcedure
    .input(z.object({ demonstrationId: z.uuid() }))
    .handler(({ context, input }) =>
      actOnDemonstration(context.sdk, context.user.id, input.demonstrationId, action),
    );

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
   * user's last Message, its Conversation's id and Messages, its Turns' provenance, its Summaries and its cache warmings,
   * and `lastSeq`, the cursor to follow its thread with `changes` from; another user's is not found.
   */
  get: protectedProcedure
    .input(z.object({ botId: z.uuid() }))
    .handler(async ({ context, input }) => {
      const found = await findBot(context.sdk.db, context.user.id, input.botId);
      if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      const { conversationId, ...bot } = found;
      // Read before the thread, so no change committed meanwhile falls behind the cursor.
      const lastSeq = await lastSeqOf(context.sdk.db, conversationId);
      const [messages, turnStatus] = await Promise.all([
        botMessages(context.sdk.db, conversationId),
        latestTurnStatus(context.sdk.db, bot.id),
      ]);
      // Each Turn's Triggers and whether it sent anything, for the dividers of Routine runs.
      const [turns, userStatus, summaries, warmings] = await Promise.all([
        turnProvenance(context.sdk.db, context.user.id, bot.id, messages),
        userTurnStatus(context.sdk.db, messages),
        botSummaries(context.sdk.db, bot.id, conversationId),
        botWarmings(context.sdk, context.user.id, bot.id),
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
    }),

  /**
   * The changes to the caller's Bot's thread after seq `since` (ADR 0026), oldest first, each
   * with what it points at as it is now (`data`, null once that is gone): a Message appended or
   * changed, a Turn's status, a Secret saved, a Routine, review, Helper or Check-in changed. A
   * cursor the change log no longer holds, or one past its newest change, gets `reload`: read the
   * thread afresh with `get`. Another user's Bot is not found.
   */
  changes: protectedProcedure
    .input(z.object({ botId: z.uuid(), since: z.number().int().min(0) }))
    .handler(({ context, input }) =>
      botChanges(context.sdk, context.user.id, input.botId, input.since),
    ),

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

  /**
   * Warms the cache of the caller's Bot (slide 32), which the Bot page asks for when the
   * Conversation opens and on the first keystroke of a draft. It does nothing while a Turn runs,
   * while the cache is still warm, or for a Model with no warming call; `skipped` says which.
   * Another user's Bot is not found.
   */
  warm: protectedProcedure
    .input(z.object({ botId: z.uuid() }))
    .handler(({ context, input }) => warmBot(context.sdk, context.user.id, input.botId)),

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
        declineRoutine(context.sdk, context.user.id, input.routineId),
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
        await stopBotHelpers(context.sdk, input.botId, input.helperId);
      }),
  },

  /** The Auto-reviews of the caller's Bots' tool calls (spec #691). */
  review: {
    /**
     * One of the caller's Bots' newest reviews and its waiting ones, oldest first, each with its
     * Turn or Helper: what the passes line under a Turn lists. Another user's Bot is not found.
     */
    list: protectedProcedure
      .input(z.object({ botId: z.uuid() }))
      .handler(async ({ context, input }) => {
        const found = await findBot(context.sdk.db, context.user.id, input.botId);
        if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
        return listReviews(context.sdk.db, input.botId);
      }),
    /**
     * Allows a blocked call while its Approval waits (ADR 0024): the call runs. A late or second
     * answer changes nothing and comes back `decided: false`, with how the request stands.
     * Another user's is not found.
     */
    allow: protectedProcedure
      .input(z.object({ reviewId: z.uuid() }))
      .handler(({ context, input }) =>
        decideReview(context.sdk, context.user.id, input.reviewId, "allowed"),
      ),
    /** Denies a blocked call while its Approval waits, as `allow` allows it: the call doesn't run. */
    deny: protectedProcedure
      .input(z.object({ reviewId: z.uuid() }))
      .handler(({ context, input }) =>
        decideReview(context.sdk, context.user.id, input.reviewId, "denied"),
      ),
  },

  /**
   * The user's Secrets (spec #691), shared by all their Bots. A value goes in through `save` and
   * never comes out: `list` returns names and dates only.
   */
  secret: {
    /**
     * Saves Secret `name`, encrypted, replacing an earlier one, and wakes the Bot `botId` with the
     * Trigger "Saved secret NAME". The value never enters the Conversation. Another user's Bot is
     * not found.
     */
    save: protectedProcedure
      .input(
        z.object({
          botId: z.uuid(),
          name: secretNameSchema,
          value: z.string().min(1).max(10_000),
        }),
      )
      .handler(({ context, input }) => saveSecret(context.sdk, context.user.id, input)),

    /** The caller's Secrets, by name, each with when it was saved. Never a value. */
    list: protectedProcedure.handler(({ context }) => listSecrets(context.sdk.db, context.user.id)),

    /** Deletes the caller's Secret `name`. */
    delete: protectedProcedure
      .input(z.object({ name: secretNameSchema }))
      .handler(({ context, input }) => deleteSecret(context.sdk, context.user.id, input.name)),
  },

  /**
   * The user's side of a Demonstration (spec #713), from its Show me card. Each acts only on a state
   * it applies to, and otherwise changes nothing; each returns the state the Demonstration is in now.
   * Done and Cancel release its Screen. Another user's is not found.
   */
  demonstration: {
    /** Pauses a recording Demonstration. */
    pause: demonstrationAction("pause"),
    /** Resumes a paused Demonstration. */
    resume: demonstrationAction("resume"),
    /** Ends a live Demonstration as Done: it goes `drafting`. */
    done: demonstrationAction("done"),
    /** Ends a live Demonstration `cancelled`. */
    cancel: demonstrationAction("cancel"),
    /**
     * A fresh live-view link to a live Demonstration's Screen, which the user drives, never stored.
     * Refused, "This Demonstration has ended.", once it ended.
     */
    view: protectedProcedure
      .input(z.object({ demonstrationId: z.uuid() }))
      .handler(({ context, input }) =>
        screenView(context.sdk, context.user.id, { demonstrationId: input.demonstrationId }),
      ),
    /**
     * The steps a Demonstration captured, in order, with a mark where the user paused: what the
     * Show me card and "What Planner sees" list. Password values come masked.
     */
    steps: protectedProcedure
      .input(z.object({ demonstrationId: z.uuid() }))
      .handler(({ context, input }) =>
        demonstrationSteps(context.sdk, context.user.id, input.demonstrationId),
      ),
  },

  /** The live view of a Computer-use Helper's Screen (#597). Another user's Helper is not found. */
  screen: {
    /**
     * A fresh live-view link to the Screen of one of the caller's live Helpers, never stored. It
     * wakes the Computer and reopens the Screen when it isn't open, and the view starts view-only.
     * Refused, "This task was stopped.", once the Helper ended.
     */
    view: protectedProcedure
      .input(z.object({ helperId: z.uuid() }))
      .handler(({ context, input }) =>
        screenView(context.sdk, context.user.id, { helperId: input.helperId }),
      ),

    /** Take control (`control`) and give back (`view`): switches the Screen's x11vnc. */
    control: protectedProcedure
      .input(z.object({ helperId: z.uuid(), mode: z.enum(["view", "control"]) }))
      .handler(({ context, input }) =>
        screenControl(context.sdk, context.user.id, input.helperId, input.mode),
      ),
  },
};

/** The `bot` plugin's routers, served under `<basePath>/rpc/<key>`. */
export const botPluginRouter = { bot: botRouter };
export type BotRouter = typeof botPluginRouter;
