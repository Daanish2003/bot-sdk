import { oc, type } from "@orpc/contract";
import { z } from "zod";

import type { BotChanges } from "./changes";
import {
  channelAccountInput,
  type ChannelAccountRow,
  saveChannelAccountInput,
} from "./channel-account";
import type { BotCheckIn } from "./check-in";
import { maxChoiceOptionLength, maxChoiceOtherLength } from "./choice";
import type { DemonstrationState, DemonstrationStep } from "./demonstration";
import type { BotHelper } from "./helper";
import {
  type NotificationSettings,
  notificationSettingsSchema,
  pushEndpointInput,
  pushSubscriptionSchema,
} from "./notifications";
import { emojiSchema } from "./reaction";
import type { BotReview, ReviewApprovalState } from "./review";
import { type BotRoutine, routineScheduleSchema } from "./routine";
import { type CustomRule, customRuleModes, customRuleTextSchema } from "./rule";
import { type BotSecret, secretNameSchema } from "./secret";
import type { BotTasks } from "./tasks";
import { isTimeZone } from "./time-zone";
import {
  type BotMessage,
  botMessageSchema,
  type BotSummary,
  type BotTurnProvenance,
  type BotTurnStatus,
  type BotWarming,
} from "./turn";

/*
 * The Bot core's contract (spec #873): one router per namespace, served under
 * `<basePath>/rpc/<namespace>` and implemented by the SDK's domain methods of the same names
 * (`sdk.bots.send` is `bots.send`). Each input schema is the one the domain method validates with,
 * so an in-process call is held to the same rules. Public interface: the browser client is typed
 * by it, and it changes only with the package's semver.
 */

/** A Bot as the client sees it. */
/** A Bot; `pausedAt` is when the user paused it (Bot pause, spec #1007), null while it isn't. */
export type Bot = {
  id: string;
  name: string;
  model: string;
  createdAt: Date;
  pausedAt: Date | null;
};

/** A Bot with the status of its latest Turn (`null` before its first). */
export type BotWithStatus = Bot & { turnStatus: BotTurnStatus | null };

/** A Bot in the list: its last sent Message's text and time (`null` before it has sent one). */
export type ListedBot = BotWithStatus & { lastMessage: { text: string; at: Date } | null };

/** One of the user's Bots and its thread, as `bots.get` reads it. */
export type BotThread = {
  bot: BotWithStatus & { userTurnStatus: BotTurnStatus | null };
  conversationId: string;
  messages: BotMessage[];
  turns: BotTurnProvenance[];
  summaries: BotSummary[];
  warmings: BotWarming[];
  /** The change log's newest seq when the thread was read: the cursor for `conversations.changes`. */
  lastSeq: number;
};

/** A file the user stored to send their Bot. */
export type BotUpload = { id: string; name: string; size: number; mediaType: string };

/** Why a warm did nothing; `warmed` is false with one of these. */
export type WarmSkipped =
  /** A Turn is running, which keeps the cache warm itself. */
  | "running"
  /** The Bot has no Prompt start yet: nothing is cached. */
  | "nothing_cached"
  /** The Bot's last model call is recent enough that the cache is still warm. */
  | "still_warm"
  /** The Model has no warming call: Gemini, the ChatGPT plan, and the other Providers. */
  | "unsupported"
  /** The Quota is used up, or the call failed. */
  | "unavailable";

export type WarmResult = { warmed: true } | { warmed: false; skipped: WarmSkipped };

/** `bots.create`'s input, besides `userId`. */
export const createBotInput = z.object({
  name: z.string().trim().min(1).max(100),
  model: z.string(),
});

/** The input of the methods that act on one of the user's Bots, besides `userId`. */
export const botInput = z.object({ botId: z.uuid() });

/** `bots.reset`'s input, besides `userId`: the Bot, and its name typed to confirm (spec #1007). */
export const resetBotInput = z.object({ botId: z.uuid(), name: z.string().max(100) });

/** `conversations.changes`' input, besides `userId`. */
export const conversationChangesInput = z.object({
  conversationId: z.uuid(),
  since: z.number().int().min(0),
});

/** `bots.send`'s input, besides `userId`. */
export const sendInput = z
  .object({
    botId: z.uuid(),
    // Lowercased, as the Trigger's text id holds it, so an uppercase resend still re-joins.
    id: z.uuidv7().transform((id) => id.toLowerCase()),
    text: z.string().trim(),
    files: z.array(z.uuid()).optional(),
    // The client's IANA zone; the Turn's newest input shows the time in it (UTC when absent).
    timeZone: z.string().refine(isTimeZone, "Not an IANA time zone").optional(),
  })
  .refine((input) => input.text !== "" || !!input.files?.length, {
    error: "A message needs text or files",
    path: ["text"],
  });

/** `bots.upload`'s input, besides `userId`. */
export const uploadInput = z.object({ file: z.file() });

/** `bots.choose`'s input, besides `userId`. */
export const chooseInput = z.object({
  botId: z.uuid(),
  messageId: z.uuid(),
  answer: z.union([
    z.object({ option: z.string().max(maxChoiceOptionLength) }),
    z.object({ other: z.string().max(maxChoiceOtherLength) }),
  ]),
});

/** `bots.react`'s input, besides `userId`. */
export const reactInput = z.object({
  botId: z.uuid(),
  messageId: z.uuid(),
  emoji: emojiSchema.nullable(),
});

/** The input of the methods scoped to one of the user's Bots, besides `userId`. */
export const botScopeInput = z.object({ botId: z.uuid() });

/** The input of the methods that act on one of the user's Routines. */
export const routineInput = z.object({ routineId: z.uuid() });

/** `triggers.skip`'s input, besides `userId`. */
export const triggerInput = z.object({ triggerId: z.string().min(1).max(512) });

/** `checkIns.cancel`'s input, besides `userId`. */
export const checkInInput = z.object({ checkInId: z.uuid() });

/** `routines.edit`'s input, besides `userId`: a new prompt, a new schedule, read-only or not. */
export const editRoutineInput = routineInput
  .extend({
    prompt: z.string().trim().min(1).optional(),
    schedule: routineScheduleSchema.optional(),
    readOnly: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.prompt !== undefined || input.schedule !== undefined || input.readOnly !== undefined,
    { error: "An edit needs a prompt, a schedule or readOnly" },
  );

/** `checkIns.edit`'s input, besides `userId`: a new time, a new note, or both. */
export const editCheckInInput = checkInInput
  .extend({ at: z.date().optional(), note: z.string().trim().min(1).optional() })
  .refine((input) => input.at !== undefined || input.note !== undefined, {
    error: "An edit needs a time or a note",
  });

/** `helpers.list`'s input, besides `userId`. */
export const helperListInput = z.object({ botId: z.uuid() });

/** `helpers.done`'s input, besides `userId`. */
export const helperDoneInput = z.object({ helperId: z.uuid() });

/** `helpers.stop`'s input, besides `userId`. */
export const helperStopInput = z.object({ botId: z.uuid(), helperId: z.uuid().optional() });

/** `reviews.list`'s input, besides `userId`. */
export const reviewListInput = z.object({ botId: z.uuid() });

/** The input of `reviews.allow` and `reviews.deny`, besides `userId`. */
export const reviewDecisionInput = z.object({ reviewId: z.uuid() });

/** `rules.create`'s input, besides `userId`. */
export const createRuleInput = z.object({
  text: customRuleTextSchema,
  mode: z.enum(customRuleModes),
});

/** The input of the `rules` methods that act on one of the user's Custom Rules, besides `userId`. */
export const ruleInput = z.object({ ruleId: z.uuid() });

/** `rules.update`'s input, besides `userId`: a new text, a new mode, or both. */
export const updateRuleInput = ruleInput
  .extend({ text: customRuleTextSchema.optional(), mode: z.enum(customRuleModes).optional() })
  .refine((input) => input.text !== undefined || input.mode !== undefined, {
    error: "An edit needs a text or a mode",
  });

/** `secrets.save`'s input, besides `userId`. */
export const saveSecretInput = z.object({
  botId: z.uuid(),
  name: secretNameSchema,
  value: z.string().min(1).max(10_000),
});

/** `secrets.delete`'s input, besides `userId`. */
export const deleteSecretInput = z.object({ name: secretNameSchema });

/** The input of the `demonstrations` methods, besides `userId`. */
export const demonstrationInput = z.object({ demonstrationId: z.uuid() });

/** `computer.view`'s input, besides `userId`. */
export const screenViewInput = z.object({ helperId: z.uuid() });

/** `computer.control`'s input, besides `userId`. */
export const screenControlInput = z.object({
  helperId: z.uuid(),
  mode: z.enum(["view", "control"]),
});

type RoutineStateChange = { id: string; state: BotRoutine["state"] };
type DemonstrationStateOut = { state: DemonstrationState };
type ReviewDecision = { decided: boolean; state: ReviewApprovalState };

const bots = {
  /**
   * Creates a Bot on one of the user's Models (`models.list`), with an empty Conversation. A Bot
   * doesn't greet: its Conversation starts with no Message.
   */
  create: oc.input(createBotInput).output(type<Bot>()),
  /** The user's Bots, the newest activity first, with their last sent Message and Turn status. */
  list: oc.output(type<ListedBot[]>()),
  /** One of the user's Bots and its thread; another user's is not found. */
  get: oc.input(botInput).output(type<BotThread>()),
  /** Sends the user's Message to their Bot and returns the saved user Message. */
  send: oc.input(sendInput).output(botMessageSchema),
  /** Stores a file the user will send their Bot. Rate-limited like attachments. */
  upload: oc.input(uploadInput).output(type<BotUpload>()),
  /** Stops the user's Bot's running Turn. */
  stop: oc.input(botInput).output(type<void>()),
  /**
   * Pauses the user's Bot (spec #1007): its Turn and Helpers stop, what waits is skipped, and
   * nothing wakes it until it is resumed. Idempotent; another user's Bot is not found.
   */
  pause: oc.input(botInput).output(type<void>()),
  /** Resumes the user's paused Bot, replaying nothing. Idempotent; another user's Bot is not found. */
  resume: oc.input(botInput).output(type<void>()),
  /**
   * Resets the user's Bot (spec #1007): it drops its Routines, Check-ins, Helpers and pending
   * Approvals, each enabled feature forgets it (Memory deletes its files), and its Conversation
   * gets a reset mark. `name` must be the Bot's name. Another user's Bot is not found.
   */
  reset: oc.input(resetBotInput).output(type<void>()),
  /**
   * One of the user's Bots' Tasks view (spec #1007): In progress, Scheduled and Done, in one read.
   * Another user's Bot is not found.
   */
  tasks: oc.input(botInput).output(type<BotTasks>()),
  /** Warms the Bot's cache, on opening and on a draft's first keystroke. */
  warm: oc.input(botInput).output(type<WarmResult>()),
  /** Answers the choice a Bot asked in Message `messageId`. */
  choose: oc.input(chooseInput).output(type<void>()),
  /** Puts the user's emoji on a Bot reply, or takes it off. */
  react: oc.input(reactInput).output(type<void>()),
};

/** The user's Bot Conversations: what changed in a thread (ADR 0026). */
const conversations = {
  /**
   * The changes to the user's Bot Conversation's thread after seq `since` (ADR 0026), oldest
   * first, each with what it points at as it is now. A cursor the change log no longer holds, or
   * one past its newest change, gets `reload`: read the thread afresh with `bots.get`.
   */
  changes: oc.input(conversationChangesInput).output(type<BotChanges>()),
};

/** The Routines of the user's Bots (#538). Approving or declining one never wakes the Bot. */
const routines = {
  /** One of the user's Bots' Routines, sorted by name, each with the Message its card follows. */
  list: oc.input(botScopeInput).output(type<BotRoutine[]>()),
  /** Approves a pending Routine: it turns `active`. */
  approve: oc.input(routineInput).output(
    type<{
      id: string;
      state: BotRoutine["state"];
      approvedAt: Date | null;
      webhookToken?: string;
    }>(),
  ),
  /** Declines a pending Routine, which deletes it. */
  decline: oc.input(routineInput).output(type<void>()),
  /** Pauses an active Routine. */
  pause: oc.input(routineInput).output(type<RoutineStateChange>()),
  /** Resumes a paused Routine with no fresh OK. */
  resume: oc.input(routineInput).output(type<RoutineStateChange>()),
  /** Deletes a Routine in any state, and nothing of it fires again. */
  delete: oc.input(routineInput).output(type<void>()),
  /**
   * The user's edit of a Routine's prompt, schedule and read-only setting (a webhook Routine has no
   * schedule).
   * It needs no Approval and keeps the Routine's state; it applies from the next run.
   */
  edit: oc.input(editRoutineInput).output(type<RoutineStateChange>()),
  /** Gives an approved webhook Routine a new URL (ADR 0021). */
  rotate: oc.input(routineInput).output(type<{ webhookToken: string }>()),
};

/** The Check-ins of the user's Bots (#540). */
const checkIns = {
  /** One of the user's Bots' Check-ins, soonest first, each with the Message its line follows. */
  list: oc.input(botScopeInput).output(type<BotCheckIn[]>()),
  /** Cancels a pending Check-in: it never fires. */
  cancel: oc.input(checkInInput).output(type<void>()),
  /** Changes a pending Check-in's time and note. One that already fired or ended is refused. */
  edit: oc.input(editCheckInInput).output(type<void>()),
};

/** The Triggers waiting in a Bot's Conversation queue (spec #1007). */
const triggers = {
  /** Skips one waiting Routine or Check-in Trigger: no Turn takes it, and Done lists it as skipped. */
  skip: oc.input(triggerInput).output(type<void>()),
};

/** The Helpers of the user's Bots (#590). */
const helpers = {
  /** One of the user's Bots' Helpers, oldest first, each with the Message its card follows. */
  list: oc.input(helperListInput).output(type<BotHelper[]>()),
  /** The user's Done on a Helper waiting at a hand-off (#568). */
  done: oc.input(helperDoneInput).output(type<{ status: "running" }>()),
  /** Stops one of the user's Bot's Helpers, or all its live ones with no `helperId`. */
  stop: oc.input(helperStopInput).output(type<void>()),
};

/** The Auto-reviews of the user's Bots' tool calls (spec #691). */
const reviews = {
  /** One of the user's Bots' newest reviews and its waiting ones. */
  list: oc.input(reviewListInput).output(type<BotReview[]>()),
  /** Allows a blocked call while its Approval waits (ADR 0024). */
  allow: oc.input(reviewDecisionInput).output(type<ReviewDecision>()),
  /** Denies a blocked call while its Approval waits, as `allow` allows it. */
  deny: oc.input(reviewDecisionInput).output(type<ReviewDecision>()),
};

/**
 * The user's Custom Rules (ADR 0031), shared by all their Bots. Another user's rule is not found.
 * `botContract` serves all of them (spec #989).
 */
export const rulesContract = {
  /** The user's Custom Rules, active and proposed, the oldest first. */
  list: oc.output(type<CustomRule[]>()),
  /** The Never-allowed classes (ADR 0032), read-only: the SDK's, then the Host's extra ones. */
  neverAllowed: oc.output(type<string[]>()),
  /** Writes an active rule. Refused past the 50 active rules. */
  create: oc.input(createRuleInput).output(type<CustomRule>()),
  /** Edits a rule's text or mode. */
  update: oc.input(updateRuleInput).output(type<CustomRule>()),
  /** Deletes a rule in any state. */
  delete: oc.input(ruleInput).output(type<void>()),
  /** Approves a rule a Bot proposed: it turns `active`. Refused past the 50 active rules. */
  approve: oc.input(ruleInput).output(type<CustomRule>()),
  /** Denies a rule a Bot proposed, which deletes it. */
  deny: oc.input(ruleInput).output(type<void>()),
};

export type RulesContract = typeof rulesContract;

/** The rules methods the SDK serves. */
const rules = {
  list: rulesContract.list,
  neverAllowed: rulesContract.neverAllowed,
  create: rulesContract.create,
  update: rulesContract.update,
  delete: rulesContract.delete,
  approve: rulesContract.approve,
  deny: rulesContract.deny,
};

/**
 * The user's notification settings (spec #1024), for all their Bots: Quiet hours and where
 * Messages from Turns they didn't start go.
 */
const notifications = {
  /** The user's settings; the defaults when they have set nothing. */
  get: oc.output(type<NotificationSettings>()),
  /** Replaces the user's settings, and returns them. */
  update: oc.input(notificationSettingsSchema).output(type<NotificationSettings>()),
  /** The user's devices that web push reaches, one subscription each. */
  push: {
    /** The Host's VAPID public key to subscribe a device with, or `null` when it offers no push. */
    key: oc.output(type<string | null>()),
    /** Saves this device's subscription for the user; a device subscribed again is replaced. */
    subscribe: oc.input(pushSubscriptionSchema).output(type<void>()),
    /** Removes this device's subscription, when it is the user's. */
    unsubscribe: oc.input(pushEndpointInput).output(type<void>()),
  },
};

/**
 * The user's Secrets (spec #691), shared by all their Bots. A value goes in through `save` and
 * never comes out: `list` returns names and dates only.
 */
const secrets = {
  /** Saves Secret `name`, encrypted, and wakes the Bot `botId` with "Saved secret NAME". */
  save: oc.input(saveSecretInput).output(type<void>()),
  /** The user's Secrets, by name, each with when it was saved. Never a value. */
  list: oc.output(type<BotSecret[]>()),
  /** Deletes the user's Secret `name`. */
  delete: oc.input(deleteSecretInput).output(type<void>()),
};

/**
 * The user's side of a Demonstration (spec #713), from its Show me card. Each acts only on a state
 * it applies to, and returns the state the Demonstration is in now.
 */
const demonstrations = {
  /** Pauses a recording Demonstration. */
  pause: oc.input(demonstrationInput).output(type<DemonstrationStateOut>()),
  /** Resumes a paused Demonstration. */
  resume: oc.input(demonstrationInput).output(type<DemonstrationStateOut>()),
  /** Ends a live Demonstration as Done: it goes `drafting`. */
  done: oc.input(demonstrationInput).output(type<DemonstrationStateOut>()),
  /** Ends a live Demonstration `cancelled`. */
  cancel: oc.input(demonstrationInput).output(type<DemonstrationStateOut>()),
  /** A fresh live-view link to a live Demonstration's Screen, never stored. */
  view: oc.input(demonstrationInput).output(type<{ url: string }>()),
  /** The steps a Demonstration captured, in order. Password values come masked. */
  steps: oc.input(demonstrationInput).output(type<{ steps: DemonstrationStep[] }>()),
};

/** The live view of a Computer-use Helper's Screen (#597). */
const computer = {
  /** A fresh live-view link to the Screen of one of the user's live Helpers, never stored. */
  view: oc.input(screenViewInput).output(type<{ url: string }>()),
  /** Take control (`control`) and give back (`view`). */
  control: oc.input(screenControlInput).output(type<void>()),
};

/**
 * The Channels besides web, served under `channels` only when the Host fills the `channels` slot,
 * so the client adds them with `channelClient()`: the email Channel (spec #761), a Bot's address
 * to copy or rotate, and the messaging Channels' Channel accounts (spec #1044), served only when
 * the slot has a messaging adapter.
 */
export const channelsContract = {
  email: {
    /** The Bot's address, made on the first read, and the Channel its next Message goes by. */
    address: oc.input(botInput).output(type<{ address: string; nextChannel: "web" | "email" }>()),
    /** Gives the Bot a new address; mail to the old one is dropped from now on. */
    rotate: oc.input(botInput).output(type<{ address: string }>()),
  },
  accounts: {
    /** Each messaging platform the Host offers, with the Bot's Channel account there, if any. */
    list: oc.input(botInput).output(type<ChannelAccountRow[]>()),
    /**
     * Adds or fixes the Bot's Channel account on a platform, once the platform accepts the
     * credentials; a rejection saves nothing. Returns the platform's row.
     */
    save: oc.input(saveChannelAccountInput).output(type<ChannelAccountRow>()),
    /** Removes the Bot's Channel account on a platform, and its listener stops. */
    remove: oc.input(channelAccountInput).output(type<void>()),
  },
};

/** The Bot core's namespaces, as the HTTP layer serves them. */
export const botContract = {
  bots,
  conversations,
  routines,
  checkIns,
  triggers,
  helpers,
  reviews,
  rules,
  notifications,
  secrets,
  demonstrations,
  computer,
};

export type BotContract = typeof botContract;

export type ChannelsContract = typeof channelsContract;
