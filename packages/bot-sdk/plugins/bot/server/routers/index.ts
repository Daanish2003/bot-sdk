import { z } from "zod";

import { protectedProcedure } from "../../../../core/server/procedures";
import { botMessageSchema } from "../../shared/turn";
import { deleteSecret, listSecrets, saveSecret } from "../safety";
import { botChanges } from "../changes";

import { screenControl, screenView } from "../helpers";

import { secretNameSchema } from "../../shared/secret";

import {
  botInput,
  chooseInput,
  createBotInput,
  reactInput,
  sendInput,
  uploadInput,
} from "../bots-api";
import type { DemonstrationAction } from "../../shared/demonstration";
import { demonstrationInput } from "../demonstrations-api";
import { helperDoneInput, helperListInput, helperStopInput } from "../helpers-api";
import { reviewDecisionInput, reviewListInput } from "../reviews-api";
import { botScopeInput, checkInInput, routineInput } from "../routines-api";

/** A route that applies `action` to one of the caller's Demonstrations. */
const demonstrationAction = (action: Exclude<DemonstrationAction, "view">) =>
  protectedProcedure
    .input(demonstrationInput)
    .handler(({ context, input }) =>
      context.sdk.demonstrations[action]({ userId: context.user.id, ...input }),
    );

const botRouter = {
  /**
   * Creates a Bot on one of the caller's Models (`models.list`), with an empty Conversation. A Bot
   * doesn't greet: its Conversation starts with no Message.
   */
  create: protectedProcedure
    .input(createBotInput)
    .handler(({ context, input }) =>
      context.sdk.bots.create({ userId: context.user.id, ...input }),
    ),

  /** The caller's Bots, the newest activity first, with their last sent Message and Turn status. */
  list: protectedProcedure.handler(({ context }) =>
    context.sdk.bots.list({ userId: context.user.id }),
  ),

  /** One of the caller's Bots and its thread (`sdk.bots.get`); another user's is not found. */
  get: protectedProcedure
    .input(botInput)
    .handler(({ context, input }) => context.sdk.bots.get({ userId: context.user.id, ...input })),

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

  /** Sends the caller's Message to their Bot (`sdk.bots.send`) and returns the saved user Message. */
  send: protectedProcedure
    .input(sendInput)
    .output(botMessageSchema)
    .handler(({ context, input }) => context.sdk.bots.send({ userId: context.user.id, ...input })),

  /** Stores a file the caller will send their Bot (`sdk.bots.upload`). Rate-limited like attachments. */
  upload: protectedProcedure
    .input(uploadInput)
    .handler(({ context, input }) =>
      context.sdk.bots.upload({ userId: context.user.id, ...input }),
    ),

  /** Stops the caller's Bot's running Turn (`sdk.bots.stop`). */
  stop: protectedProcedure
    .input(botInput)
    .handler(({ context, input }) => context.sdk.bots.stop({ userId: context.user.id, ...input })),

  /** Warms the cache of the caller's Bot (`sdk.bots.warm`), on opening and on a draft's first keystroke. */
  warm: protectedProcedure
    .input(botInput)
    .handler(({ context, input }) => context.sdk.bots.warm({ userId: context.user.id, ...input })),

  /** Answers the choice a Bot asked in Message `messageId` (`sdk.bots.choose`). */
  choose: protectedProcedure
    .input(chooseInput)
    .handler(({ context, input }) =>
      context.sdk.bots.choose({ userId: context.user.id, ...input }),
    ),

  /** Puts the user's emoji on a Bot reply, or takes it off (`sdk.bots.react`). */
  react: protectedProcedure
    .input(reactInput)
    .handler(({ context, input }) => context.sdk.bots.react({ userId: context.user.id, ...input })),

  /** The Routines of the caller's Bots (#538), over `sdk.routines`. Approving or declining one never wakes the Bot. */
  routine: {
    /** One of the caller's Bots' Routines, sorted by name, each with the Message its card follows. */
    list: protectedProcedure
      .input(botScopeInput)
      .handler(({ context, input }) =>
        context.sdk.routines.list({ userId: context.user.id, ...input }),
      ),

    /** Approves a pending Routine: it turns `active`. Another user's is not found. */
    approve: protectedProcedure
      .input(routineInput)
      .handler(({ context, input }) =>
        context.sdk.routines.approve({ userId: context.user.id, ...input }),
      ),

    /** Declines a pending Routine, which deletes it. Another user's is not found. */
    decline: protectedProcedure
      .input(routineInput)
      .handler(({ context, input }) =>
        context.sdk.routines.decline({ userId: context.user.id, ...input }),
      ),

    /** Pauses an active Routine (`sdk.routines.pause`). Another user's is not found. */
    pause: protectedProcedure
      .input(routineInput)
      .handler(({ context, input }) =>
        context.sdk.routines.pause({ userId: context.user.id, ...input }),
      ),

    /** Resumes a paused Routine with no fresh OK. Another user's is not found. */
    resume: protectedProcedure
      .input(routineInput)
      .handler(({ context, input }) =>
        context.sdk.routines.resume({ userId: context.user.id, ...input }),
      ),

    /** Deletes a Routine in any state, and nothing of it fires again. Another user's is not found. */
    delete: protectedProcedure
      .input(routineInput)
      .handler(({ context, input }) =>
        context.sdk.routines.delete({ userId: context.user.id, ...input }),
      ),

    /** Gives an approved webhook Routine a new URL (ADR 0021). Another user's is not found. */
    rotate: protectedProcedure
      .input(routineInput)
      .handler(({ context, input }) =>
        context.sdk.routines.rotate({ userId: context.user.id, ...input }),
      ),
  },

  /** The Check-ins of the caller's Bots (#540), over `sdk.checkIns`. */
  checkIn: {
    /** One of the caller's Bots' Check-ins, soonest first, each with the Message its line follows. */
    list: protectedProcedure
      .input(botScopeInput)
      .handler(({ context, input }) =>
        context.sdk.checkIns.list({ userId: context.user.id, ...input }),
      ),

    /** Cancels a pending Check-in: it never fires. Another user's is not found. */
    cancel: protectedProcedure
      .input(checkInInput)
      .handler(({ context, input }) =>
        context.sdk.checkIns.cancel({ userId: context.user.id, ...input }),
      ),
  },

  /** The Helpers of the caller's Bots (#590), over `sdk.helpers`. */
  helper: {
    /** One of the caller's Bots' Helpers, oldest first, each with the Message its card follows. */
    list: protectedProcedure
      .input(helperListInput)
      .handler(({ context, input }) =>
        context.sdk.helpers.list({ userId: context.user.id, ...input }),
      ),

    /** The user's Done on a Helper waiting at a hand-off (#568). Another user's Helper is not found. */
    done: protectedProcedure
      .input(helperDoneInput)
      .handler(({ context, input }) =>
        context.sdk.helpers.done({ userId: context.user.id, ...input }),
      ),

    /** Stops one of the caller's Bot's Helpers, or all its live ones with no `helperId`. */
    stop: protectedProcedure
      .input(helperStopInput)
      .handler(({ context, input }) =>
        context.sdk.helpers.stop({ userId: context.user.id, ...input }),
      ),
  },

  /** The Auto-reviews of the caller's Bots' tool calls (spec #691), over `sdk.reviews`. */
  review: {
    /** One of the caller's Bots' newest reviews and its waiting ones. Another user's Bot is not found. */
    list: protectedProcedure
      .input(reviewListInput)
      .handler(({ context, input }) =>
        context.sdk.reviews.list({ userId: context.user.id, ...input }),
      ),
    /** Allows a blocked call while its Approval waits (ADR 0024). Another user's is not found. */
    allow: protectedProcedure
      .input(reviewDecisionInput)
      .handler(({ context, input }) =>
        context.sdk.reviews.allow({ userId: context.user.id, ...input }),
      ),
    /** Denies a blocked call while its Approval waits, as `allow` allows it. */
    deny: protectedProcedure
      .input(reviewDecisionInput)
      .handler(({ context, input }) =>
        context.sdk.reviews.deny({ userId: context.user.id, ...input }),
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
    /** A fresh live-view link to a live Demonstration's Screen, never stored. */
    view: protectedProcedure
      .input(demonstrationInput)
      .handler(({ context, input }) =>
        context.sdk.demonstrations.view({ userId: context.user.id, ...input }),
      ),
    /** The steps a Demonstration captured, in order. Password values come masked. */
    steps: protectedProcedure
      .input(demonstrationInput)
      .handler(({ context, input }) =>
        context.sdk.demonstrations.steps({ userId: context.user.id, ...input }),
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

// The email Channel's router type, for the channel client (ADR 0005: clients import routers/index only).
export type { ChannelRouter } from "./channel";
