import { and, asc, count, eq, gt, gte, inArray, isNull, max, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { type MessagingReach, MessagingSendError } from "@botsdk/bot/channel";
import type { FeatureContext } from "@botsdk/bot/feature";
import { rpcError } from "@botsdk/bot/rpc-error";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { defineJob } from "@botsdk/bot/runner/internal";
import { limitNoteKind, type ReplySource, type StoredReplyKind } from "../shared/replies";
import { AccountSendError, type ChannelOf, type CustomerChannel } from "./customer-proof";
import { combinedProfilesOf } from "./customer-profile";
import { holdThreadCustomer } from "./customers";
import {
  draftRule,
  type GateOutcome,
  type OutboundKind,
  type TopicMode,
  representative,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import { isQuiet, quietEndsAt, zoneOr } from "./quiet-hours";
import { modeOfLabel, sourcesBelongToLabel } from "./topics";
import { hintVisitor } from "./visitor-hints";

/*
 * The Outbound gate (ticket #1298): one code-owned check of every message to a Customer, in a fixed
 * order. The first rule that fails decides, and every decision is logged with its rule and Release,
 * in the transaction of the message's own write. A Model has no say in it. A message the gate sends
 * goes to the Channel by a job queued in that transaction, so it survives a crash and a Channel's
 * brief failure, and a replay of a Turn queues nothing twice.
 */

export const channelRule = "channel";
export const channelLimits = () =>
  rpcError(
    "CONFLICT",
    "error.channelLimits",
    "This Channel doesn't let this message go now: its reply window has closed, it is too long, or it can't start a chat",
  );

/** What every sender of a message to a Customer is given: the Channel it goes by, which the gate asks for limits. */
export type ViaChannel = { channel: Pick<CustomerChannel, "reach"> };

/** The fixed order. A rule with no check yet (`liveChecks`) passes everything until its ticket adds one. */
export const gateOrder = [
  "held",
  "blocked",
  "optedOut",
  "on",
  "caps",
  "quietHours",
  "channel",
  "topic",
] as const;
export type GateRule = (typeof gateOrder)[number];

/** The rule a message going by itself is held again by, when its topic stops it. */
const releaseTopicRule = "topicAtRelease";

/** What holds a message, in the words of a Page to the owner. */
const heldBecause: Record<string, string> = {
  caps: "your limits on how much it may send",
  quietHours: "quiet hours",
  channel: "the Channel's limits",
  [releaseTopicRule]: "its topic, which you haven't let send by itself",
};

/** Which rules each message passes: the takeover note, say, would otherwise be refused by its own thread. */
const rulesOf: Record<OutboundKind, readonly GateRule[]> = {
  reply: gateOrder,
  code_hand_off: ["held", "blocked", "optedOut", "on", "channel"],
  limit_note: ["held", "blocked", "optedOut", "on", "channel"],
  // The fixed note for stalled work, which a Customer is owed only while the Representative holds the thread.
  // The business speaks unprompted, after a silence, so quiet hours hold it until they end.
  stall_note: ["held", "blocked", "optedOut", "on", "quietHours", "channel"],
  owner: ["blocked", "optedOut", "channel"],
  // The owner's send passes the Channel's limits: they chose to. A release by itself checks them again.
  released: ["blocked", "optedOut"],
  takeover_note: ["blocked", "optedOut", "channel"],
  proof: ["blocked", "optedOut", "channel"],
  // The words that tell a Customer their opt-out worked: the rule that drops the rest can't drop it.
  opt_out_confirmation: ["blocked", "channel"],
  // Safety wins: only a block stops it, and a Channel that can't deliver it, which holds it for the owner.
  emergency_script: ["blocked", "channel"],
  // That held script when the owner sends it. Still safety text, so an opt-out doesn't stop it, and they chose to pass the Channel's limits.
  emergency_script_released: ["blocked"],
  // The fixed notice for a Customer who writes when nobody can answer: it is sent while the Representative is off, so it skips `on`, and code's own, so it skips the caps. The Customer has just written, so quiet hours don't apply.
  unavailable_notice: ["held", "blocked", "optedOut", "channel"],
  // The draft's holding note answers a Customer who just wrote, so quiet hours don't apply. It passes
  // all a reply does but the topic and the caps: the owner's word settles a draft, and the note is code's.
  holding_note: gateOrder.filter(
    (rule) => rule !== "topic" && rule !== "caps" && rule !== "quietHours",
  ),
  reply_draft: gateOrder.filter((rule) => rule !== "topic" && rule !== "caps"),
};

/**
 * What becomes of a message the Channel's limits stop. A reply, the code's hand-off, a release by
 * itself and the emergency script, which can't go stale as a note does, wait for the owner, to send or
 * drop. Every other kind is not kept: the owner's own send and
 * an approved draft are refused to the owner who is right there, a proof has no secret to keep, and a
 * fixed note is stale once the moment has passed.
 */
const heldWhenLimited = new Set<OutboundKind>([
  "reply",
  "code_hand_off",
  "released",
  "emergency_script",
]);

/** What the rules read of a message's thread. */
type GateFacts = {
  threadState: string;
  blockedAt: Date | null;
  /** When the identity the message goes to opted out; null when it hasn't. */
  optedOutAt: Date | null;
  enabled: boolean;
  /** The owner's mode for the topic the message is labelled with; null for one they don't have. */
  topicMode: TopicMode | null;
  /** Whether the reply rests on Published facts of that topic alone, and on at least one. */
  sourcesOnTopic: boolean;
  /** Messages the Representative has sent since the Customer last wrote on this thread. */
  sentInARow: number;
  /** Messages the Representative has sent this Customer in the day up to now, on any thread. */
  sentToday: number;
  /** The owner's caps on those two. */
  maxInARow: number;
  maxPerDay: number;
  /** The message starts with the business: no new Customer message is being answered. */
  businessStarted: boolean;
  /** What the platform of the Channel it goes by limits; nothing, if its adapter declares nothing. */
  reach: MessagingReach;
  /** Hours since the Customer last wrote from the address it goes to; null when they never have. */
  hoursSinceHeard: number | null;
  /** Whether a message of this kind waits for the owner when the Channel's limits stop it; otherwise it is dropped. */
  holdsWhenLimited: boolean;
  /** How long the message is. */
  length: number;
  /** It is quiet hours where the Customer is, or where the business is when that is unknown. */
  quiet: boolean;
};

/** The day the per-day cap counts over, up to the message's time. */
const dayMs = 24 * 60 * 60 * 1000;

export type GateCheck = (facts: GateFacts) => Exclude<GateOutcome, "send"> | null;

/** The rules that exist. Each ticket adds its rule here. */
export const liveChecks: Partial<Record<GateRule, GateCheck>> = {
  held: ({ threadState }) => (threadState === "representative" ? null : "drop"),
  blocked: ({ blockedAt }) => (blockedAt === null ? null : "drop"),
  optedOut: ({ optedOutAt }) => (optedOutAt === null ? null : "drop"),
  on: ({ enabled }) => (enabled ? null : "drop"),
  topic: ({ topicMode, sourcesOnTopic }) =>
    topicMode === "auto" && sourcesOnTopic ? null : "hold",
  caps: ({ sentInARow, sentToday, maxInARow, maxPerDay }) =>
    sentInARow >= maxInARow || sentToday >= maxPerDay ? "hold" : null,
  quietHours: ({ businessStarted, quiet }) => (businessStarted && quiet ? "hold" : null),
  // Held, never sent by another way: the address is the one the Customer wrote from, and the owner decides.
  channel: ({ reach, businessStarted, hoursSinceHeard, length, holdsWhenLimited }) =>
    (reach.canStartConversation === false && businessStarted) ||
    (reach.replyWindowHours !== undefined &&
      (hoursSinceHeard === null || hoursSinceHeard > reach.replyWindowHours)) ||
    (reach.maxLength !== undefined && length > reach.maxLength)
      ? holdsWhenLimited
        ? "hold"
        : "drop"
      : null,
};

/** The rule whose hold lets itself go: the message is sent when the quiet period ends. */
const quietRule: GateRule = "quietHours";

/** What a Page for a held message says raised it. */
const heldCause = "outbound_held";

/** What a decision's `rule` says when no rule stopped the message. */
const passedRule = "passed";

export type Outgoing = {
  kind: OutboundKind;
  threadId: string;
  to: { channel: string; externalId: string };
  now: Date;
  /** The Release of the Turn behind it; left out, the Representative's live one. */
  releaseId?: string | null;
  /** The Customer it reaches when that isn't the thread's: a proof can go to another's identity. */
  customerId?: string;
  /** Where a Turn keeps what the gate refuses, for `logRefusals`. */
  refusals?: GateRefusal[];
  /** Pages the owner when the gate holds a message; without it nobody is told. */
  pages?: PagesService;
  /** Sends a message held for quiet hours when they end; without it, the owner has to send it. */
  jobs?: JobsService;
  /** The message starts with the business, such as a relayed Bot result: quiet hours hold it. */
  businessStarted?: boolean;
  /**
   * The Channel it goes by, which the gate asks for its platform's limits (ticket #1305). Required, so a
   * sender can't forget it: a path with no Channel can't pass the gate.
   */
  channel: Pick<CustomerChannel, "reach">;
  /**
   * The id of the held message this is the automatic release of: it also passes `on`, `caps` and the topic, and
   * holding it again writes no second held row. A Page for it counts the other held messages only.
   */
  releasing?: string;
  /** With `releasing`: the kind of the decision that held it. It adds only the rules that kind lists, so the topic is a reply's and not a fixed note's. */
  heldKind?: OutboundKind;
  /** What is held if the gate holds it. A proof has none: its secret is never stored. */
  content?: {
    text: string;
    verified: boolean;
    replyKind?: StoredReplyKind;
    sources?: ReplySource[];
    /** The topic a reply was labelled with, as the Model wrote it. */
    topic?: string;
  };
};

export type GateDecision = { id: string; outcome: GateOutcome; rule: string };

type PagesService = FeatureContext<"pages">["pages"];
type JobsService = FeatureContext["jobs"];

type DecisionRow = typeof representativeOutboundDecision.$inferInsert;
type HeldRow = typeof representativeHeldMessage.$inferInsert;

/** A decision that sent nothing, as written: the same ids, so writing it twice leaves one. */
export type GateRefusal = {
  decision: DecisionRow;
  held?: HeldRow;
  /** What to tell the owner when this is the first time it is written. */
  page?: Parameters<PagesService["send"]>[1];
  /** When a held message goes by itself: the end of its quiet hours. */
  releaseAt?: Date;
};

export const heldReleaseJobName = "representative.held-release";
export const heldReleasePayload = z.object({ heldId: z.uuid() });
const heldReleaseJob = { name: heldReleaseJobName, payload: heldReleasePayload };

/** Sends the held message `heldId` at `at`: one job for each time it is asked for. */
export async function enqueueHeldRelease(
  jobs: JobsService,
  tx: Transaction,
  heldId: string,
  at: Date,
) {
  await jobs.enqueueIn(
    tx,
    heldReleaseJob,
    { heldId },
    { idempotencyKey: `${heldReleaseJobName}:${heldId}:${at.getTime()}`, runAfter: at },
  );
}

async function writeDecision(
  tx: Transaction,
  { decision, held, page, releaseAt }: GateRefusal,
  pages?: PagesService,
  jobs?: JobsService,
) {
  const [written] = await tx
    .insert(representativeOutboundDecision)
    .values(decision)
    .onConflictDoNothing()
    .returning({ id: representativeOutboundDecision.id });
  // Only with its decision: written again, it mustn't bring back what has since been answered or
  // dropped (a new Customer message), nor queue its release again.
  if (!written) return;
  if (held) await tx.insert(representativeHeldMessage).values(held);
  if (held && releaseAt && jobs) await enqueueHeldRelease(jobs, tx, held.id, releaseAt);
  if (page && pages) await pages.send(tx, page);
}

/**
 * Writes what a Turn's gate refused, once the Turn has ended. A takeover or a block cancels the Turn,
 * and its fence rolls back the transaction that logged the refusal; one that committed is left as it
 * is. A thread gone by then took its log with it.
 */
export async function logRefusals(
  { db, pages, jobs }: Pick<FeatureContext<"pages">, "db" | "pages" | "jobs">,
  refusals: GateRefusal[],
) {
  for (const refusal of refusals) {
    await db.transaction(async (tx) => {
      const [thread] = await tx
        .select({ id: representativeThread.id })
        .from(representativeThread)
        .where(eq(representativeThread.id, refusal.decision.threadId))
        .for("key share");
      if (thread) await writeDecision(tx, refusal, pages, jobs);
    });
  }
}

/**
 * Takes the locks a rule on the thread needs, in the order the owner's changes take them: the
 * Representative's row, in a mode any number of Turns can hold, then the Customer's, then the
 * thread's. A switch-off, a block or a takeover then lands either before this decision or after this
 * transaction's message. False when the thread has gone.
 */
export async function holdForRules(tx: Transaction, threadId: string) {
  const [thread] = await tx
    .select({ representativeId: representativeThread.representativeId })
    .from(representativeThread)
    .where(eq(representativeThread.id, threadId));
  if (!thread) return false;
  await tx
    .select({ id: representative.id })
    .from(representative)
    .where(eq(representative.id, thread.representativeId))
    .for("share");
  const customerId = await holdThreadCustomer(tx, threadId);
  if (!customerId) return false;
  await tx
    .select({ id: representativeCustomer.id })
    .from(representativeCustomer)
    .where(eq(representativeCustomer.id, customerId))
    .for("share");
  await tx
    .select({ id: representativeThread.id })
    .from(representativeThread)
    .where(eq(representativeThread.id, threadId))
    .for("update");
  return true;
}

/**
 * What the caps count: the Representative's messages after the Customer's last on this thread, and the
 * sends in the day before `now` to any thread of the Customer. A send is a decision that passed and
 * went by a job; the thread's lock, which the caller holds, keeps the first count from racing.
 */
async function sentCounts(tx: Transaction, threadId: string, customerId: string, now: Date) {
  const message = representativeThreadMessage;
  const [lastHeard] = await tx
    .select({ position: max(message.position) })
    .from(message)
    .where(and(eq(message.threadId, threadId), eq(message.author, "customer")));
  const [inARow] = await tx
    .select({ count: count() })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        eq(message.author, "representative"),
        gt(message.position, lastHeard?.position ?? 0),
        sql`${message.replyKind} is distinct from ${limitNoteKind}`,
      ),
    );
  const decision = representativeOutboundDecision;
  const [today] = await tx
    .select({ count: count() })
    .from(decision)
    .innerJoin(representativeThread, eq(representativeThread.id, decision.threadId))
    .where(
      and(
        eq(representativeThread.customerId, customerId),
        inArray(decision.kind, ["reply", "code_hand_off", "released", "reply_draft"]),
        eq(decision.outcome, "send"),
        gt(decision.createdAt, sql`${new Date(now.getTime() - dayMs).toISOString()}::timestamp`),
      ),
    );
  return { sentInARow: inARow!.count, sentToday: today!.count };
}

/** Hours from the Customer's last message from `from` on the thread to `now`; null when they never wrote from it. */
async function hoursSinceHeard(
  tx: Transaction,
  threadId: string,
  from: { channel: string; externalId: string },
  now: Date,
) {
  const message = representativeThreadMessage;
  const [last] = await tx
    .select({ at: max(message.createdAt) })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        eq(message.author, "customer"),
        eq(message.channel, from.channel),
        eq(message.externalId, from.externalId),
      ),
    );
  return last?.at ? (now.getTime() - last.at.getTime()) / (60 * 60 * 1000) : null;
}

/**
 * The time zone a Customer's quiet hours are read in: theirs when the owner set it or a verified
 * message of theirs said it, otherwise `fallback`, the business's. An unverified sender's claim of a
 * daytime zone must not lift the quiet hours.
 */
async function customerZone(tx: Transaction, userId: string, customerId: string, fallback: string) {
  const profile = await combinedProfilesOf(tx, userId, [customerId]);
  const zone = profile
    .get(customerId)
    ?.find(
      ({ field, status, source }) =>
        field === "time_zone" && (status === "confirmed" || source === "owner"),
    );
  return zoneOr(zone?.value, fallback);
}

/**
 * Whether it is quiet hours for the Customer of `threadId` at `now`, by the Representative's hours
 * as they stand, and when they end.
 */
export async function quietAt(tx: Transaction, threadId: string, now: Date) {
  const [row] = await tx
    .select({
      userId: representative.userId,
      customerId: representativeThread.customerId,
      startHour: representative.quietStartHour,
      endHour: representative.quietEndHour,
      businessTimeZone: representative.businessTimeZone,
    })
    .from(representativeThread)
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .where(eq(representativeThread.id, threadId));
  if (!row) return null;
  const timeZone = await customerZone(tx, row.userId, row.customerId, row.businessTimeZone);
  const period = { startHour: row.startHour, endHour: row.endHour };
  return { quiet: isQuiet(now, timeZone, period), endsAt: quietEndsAt(now, timeZone, period) };
}

/**
 * Decides what becomes of `outgoing` and logs it, in `tx`. A held message is stored here; a sent one
 * the caller stores in its thread, and then hands to `deliverMessage`. Null when the thread has gone,
 * so there's nothing to log it on and nothing is sent. The owner's paths hold the thread before this,
 * and a proof holds its Customer before it comes here.
 */
export async function passGate(
  tx: Transaction,
  outgoing: Outgoing,
  checks: Partial<Record<GateRule, GateCheck>> = liveChecks,
): Promise<GateDecision | null> {
  const { kind, threadId, to, now, content } = outgoing;
  const rules: readonly GateRule[] = outgoing.releasing
    ? [
        ...rulesOf[kind],
        ...(["on", "caps", "channel", "topic"] as const).filter((rule) =>
          rulesOf[outgoing.heldKind ?? "reply"].includes(rule),
        ),
      ]
    : rulesOf[kind];
  if (rules.includes("held") && !(await holdForRules(tx, threadId))) return null;
  const [row] = await tx
    .select({
      threadState: representativeThread.state,
      customerId: representativeThread.customerId,
      enabled: representative.enabled,
      liveReleaseId: representative.liveReleaseId,
      userId: representative.userId,
      representativeId: representative.id,
      name: representative.name,
      maxInARow: representative.maxInARow,
      maxPerDay: representative.maxPerDay,
      quietStartHour: representative.quietStartHour,
      quietEndHour: representative.quietEndHour,
      businessTimeZone: representative.businessTimeZone,
    })
    .from(representativeThread)
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .where(eq(representativeThread.id, threadId));
  if (!row) return null;
  const [customer] = await tx
    .select({ blockedAt: representativeCustomer.blockedAt })
    .from(representativeCustomer)
    .where(eq(representativeCustomer.id, outgoing.customerId ?? row.customerId));
  const [identity] = await tx
    .select({ optedOutAt: representativeCustomerIdentity.optedOutAt })
    .from(representativeCustomerIdentity)
    .where(
      and(
        eq(representativeCustomerIdentity.userId, row.userId),
        eq(representativeCustomerIdentity.channel, to.channel),
        eq(representativeCustomerIdentity.externalId, to.externalId),
      ),
    );
  const businessStarted = outgoing.businessStarted ?? false;
  // The Customer's time zone wins, the business's is used when it's unknown.
  let timeZone = row.businessTimeZone;
  if (rules.includes(quietRule) && businessStarted) {
    timeZone = await customerZone(
      tx,
      row.userId,
      outgoing.customerId ?? row.customerId,
      row.businessTimeZone,
    );
  }
  const period = { startHour: row.quietStartHour, endHour: row.quietEndHour };
  const topicMode = rules.includes("topic")
    ? await modeOfLabel(tx, row.userId, content?.topic)
    : null;
  const reach = outgoing.channel.reach?.(to.channel) ?? {};
  const facts: GateFacts = {
    ...row,
    businessStarted,
    reach,
    holdsWhenLimited: heldWhenLimited.has(kind),
    length: content?.text.length ?? 0,
    hoursSinceHeard:
      rules.includes("channel") && reach.replyWindowHours !== undefined
        ? await hoursSinceHeard(tx, threadId, to, now)
        : null,
    quiet: isQuiet(now, timeZone, period),
    blockedAt: customer?.blockedAt ?? null,
    topicMode,
    // Only an auto topic can send, so only then does it matter.
    sourcesOnTopic:
      topicMode === "auto" &&
      (await sourcesBelongToLabel(tx, row.userId, content?.topic, content?.sources)),
    optedOutAt: identity?.optedOutAt ?? null,
    ...(rules.includes("caps")
      ? await sentCounts(tx, threadId, row.customerId, now)
      : { sentInARow: 0, sentToday: 0 }),
  };

  let outcome: GateOutcome = "send";
  let rule: string = passedRule;
  for (const each of gateOrder) {
    if (!rules.includes(each)) continue;
    const failed = checks[each]?.(facts);
    if (failed) {
      outcome = failed;
      rule = each;
      break;
    }
  }

  // A held message its topic stops on the way out stays a held message: not a Reply draft, which is
  // what a held row whose decision says `topic` is.
  if (outgoing.releasing && rule === draftRule) rule = releaseTopicRule;
  const id = uuidv7();
  const written: GateRefusal = {
    decision: {
      id,
      threadId,
      kind,
      outcome,
      rule,
      releaseId: outgoing.releaseId ?? row.liveReleaseId,
      channel: to.channel,
      externalId: to.externalId,
      createdAt: now,
    },
    ...(rule === quietRule && { releaseAt: quietEndsAt(now, timeZone, period) }),
    ...(outcome === "hold" &&
      content &&
      !outgoing.releasing && {
        held: {
          id: uuidv7(),
          decisionId: id,
          threadId,
          text: content.text,
          verified: content.verified,
          replyKind: content.replyKind,
          sources: content.sources,
          topic: content.topic,
          createdAt: now,
        },
      }),
  };
  // One Page until the owner has dealt with what is held: a Model that keeps replying isn't a new alarm.
  // A Reply draft pages nobody when it is written: the Customer has had their note, and it's expected.
  // Nor do quiet hours: they end by themselves, so the owner is told of what waits for them, not for morning.
  const pageable =
    outcome === "hold" && (rule !== draftRule || !!outgoing.releasing) && rule !== quietRule;
  const [waiting] = pageable
    ? await tx
        .select({ id: representativeHeldMessage.id })
        .from(representativeHeldMessage)
        .innerJoin(
          representativeOutboundDecision,
          eq(representativeOutboundDecision.id, representativeHeldMessage.decisionId),
        )
        .where(
          and(
            eq(representativeHeldMessage.threadId, threadId),
            isNull(representativeHeldMessage.resolution),
            ne(representativeOutboundDecision.rule, draftRule),
            outgoing.releasing ? ne(representativeHeldMessage.id, outgoing.releasing) : undefined,
          ),
        )
        .limit(1)
    : [];
  if (pageable && !waiting) {
    written.page = {
      userId: row.userId,
      cause: heldCause,
      urgency: "routine",
      title: "A message to a Customer is waiting for you",
      text: `The Outbound gate held a message from ${row.name} to a Customer, because of ${heldBecause[rule] ?? rule}. Open the thread to send or drop it.`,
      path: `/representatives/${row.representativeId}`,
    };
  }
  await writeDecision(tx, written, outgoing.pages, outgoing.jobs);
  // Held again: what the row says holds it is this decision, not the one it was first held by.
  if (outcome === "hold" && outgoing.releasing) {
    await tx
      .update(representativeHeldMessage)
      .set({ decisionId: id })
      .where(eq(representativeHeldMessage.id, outgoing.releasing));
  }
  // Written again only if its Turn's fence rolled this back. A Turn stopped like that has no say over
  // what it wrote, so it waits for nobody, and there is nothing to tell the owner.
  if (outcome !== "send") {
    outgoing.refusals?.push({
      decision: written.decision,
      ...(written.held && {
        held: { ...written.held, resolution: "cancelled", resolvedAt: now },
      }),
    });
  }
  return { id, outcome, rule };
}

/** Who a word on a thread came from: a verified one speaks for the Customer, an unverified one for its address. */
export type Sender = { channel: string; externalId: string; verified: boolean };

/**
 * Of what is held, for a query over held rows and their decisions, what a newer word from `by` puts
 * out of date: what is to that address and, if it is verified, what is to any verified sender. An
 * unverified sender's at another address answers what nobody else was told, and no later Turn does.
 */
export const outdatedBy = (by: Sender) =>
  or(
    and(
      eq(representativeOutboundDecision.channel, by.channel),
      eq(representativeOutboundDecision.externalId, by.externalId),
    ),
    by.verified ? eq(representativeHeldMessage.verified, true) : undefined,
  );

/**
 * Drops the messages held on `threadId` (just `heldId` when given, and just what `by` outdates when
 * given), each with a decision of its own saying `rule`, and returns how many. The held message goes;
 * its first decision stays in the log. A Reply draft has its own answers, and stays (`reply-drafts`), and
 * a held emergency script goes only by its `heldId`: nothing a Customer says next puts it out of date.
 */
export async function dropHeld(
  tx: Transaction,
  {
    threadId,
    heldId,
    by,
    since,
    kind,
    rule,
    now,
  }: {
    threadId: string;
    heldId?: string;
    by?: Sender;
    /** Only what was held from this id on, an id being made in the order things happen. */
    since?: string;
    kind: OutboundKind;
    rule: string;
    now: Date;
  },
) {
  const held = representativeHeldMessage;
  const decision = representativeOutboundDecision;
  const rows = await tx
    .select({
      id: held.id,
      releaseId: decision.releaseId,
      channel: decision.channel,
      externalId: decision.externalId,
    })
    .from(held)
    .innerJoin(decision, eq(decision.id, held.decisionId))
    .where(
      and(
        eq(held.threadId, threadId),
        heldId ? eq(held.id, heldId) : ne(decision.kind, "emergency_script"),
        by && outdatedBy(by),
        since ? gte(held.id, since) : undefined,
        isNull(held.resolution),
        ne(decision.rule, draftRule),
      ),
    )
    .for("update", { of: held });
  for (const { id, ...to } of rows) {
    await tx.delete(held).where(eq(held.id, id));
    await writeDecision(tx, {
      decision: { id: uuidv7(), threadId, kind, outcome: "drop", rule, createdAt: now, ...to },
    });
  }
  return rows.length;
}

export const customerDeliveryJobName = "representative.customer-delivery";

/** Only the decision: its words stay in the thread, and go with it. */
const deliveryPayload = z.object({ decisionId: z.uuid() });
const deliveryJob = { name: customerDeliveryJobName, payload: deliveryPayload };

/**
 * Sends the thread message `messageId` that decision `decisionId` passed, once `tx` commits. Each
 * message has its own job, so one the Channel fails can go after a later one on its retry, and a
 * worker lost just after a send sends it again. A message that never goes gets a decision saying so.
 */
export async function deliverMessage(
  { jobs }: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  decisionId: string,
  messageId: string,
) {
  await tx
    .update(representativeOutboundDecision)
    .set({ messageId })
    .where(eq(representativeOutboundDecision.id, decisionId));
  await jobs.enqueueIn(
    tx,
    deliveryJob,
    { decisionId },
    { idempotencyKey: `${customerDeliveryJobName}:${decisionId}` },
  );
}

/**
 * Stores a message the gate passed as the next one on the thread, whose row `tx` holds, and sends it.
 * A reply that answers its Turn's batch also says `turnFrom: null` in `threadChanges`.
 */
export async function storeAndDeliver(
  services: Pick<FeatureContext, "jobs">,
  tx: Transaction,
  decisionId: string,
  message: Omit<typeof representativeThreadMessage.$inferInsert, "id" | "position">,
  now: Date,
  threadChanges: { turnFrom?: null } = {},
) {
  const [updated] = await tx
    .update(representativeThread)
    .set({
      messageCount: sql`${representativeThread.messageCount} + 1`,
      updatedAt: sql`greatest(${representativeThread.updatedAt}, ${now.toISOString()}::timestamp)`,
      ...threadChanges,
    })
    .where(eq(representativeThread.id, message.threadId))
    .returning({ position: representativeThread.messageCount });
  const messageId = uuidv7();
  await tx
    .insert(representativeThreadMessage)
    .values({ id: messageId, position: updated!.position, ...message });
  await deliverMessage(services, tx, decisionId, messageId);
  return messageId;
}

/** Why a message the gate passed never went, as the log says it. */
const notDelivered = {
  failed: "delivery_failed",
  blocked: "blocked",
  optedOut: "optedOut",
  moved: "address_changed",
  banned: "owner_banned",
};

/** Logs that the message `decisionId` passed didn't go after all, so a web chat session stops reading it. */
async function logNotDelivered(
  services: Pick<FeatureContext<"pubsub">, "db" | "pubsub" | "logger">,
  decisionId: string,
  rule: string,
  now: Date,
) {
  const dropped = await services.db.transaction(async (tx) => {
    const [passed] = await tx
      .select()
      .from(representativeOutboundDecision)
      .where(eq(representativeOutboundDecision.id, decisionId));
    if (!passed) return null;
    const decision = { ...passed, id: uuidv7(), outcome: "drop" as const, rule, createdAt: now };
    await writeDecision(tx, { decision });
    return passed;
  });
  if (dropped) hintVisitor(services, dropped);
}

/**
 * Sends what the gate passed. A throw is the runner's to retry, so this can run well after the
 * decision: a Customer blocked or opted out since gets nothing, and neither does an address no longer
 * theirs, which may be someone else's. During the owner's Ban their line says only what is meant for a
 * Customer regardless. A thread deleted since sends nothing.
 */
export const customerDeliveryJob = (channelOf: ChannelOf, concurrency: number) =>
  defineJob<z.infer<typeof deliveryPayload>, FeatureContext<"channelAccounts" | "pubsub">>({
    name: customerDeliveryJobName,
    payload: deliveryPayload,
    concurrency,
    run: async ({ decisionId }, job) => {
      const decision = representativeOutboundDecision;
      const [row] = await job.db
        .select({
          channel: decision.channel,
          externalId: decision.externalId,
          kind: decision.kind,
          representativeId: representativeThread.representativeId,
          userId: representative.userId,
          channelAccountId: representativeThread.channelAccountId,
          sentOn: decision.sentOn,
          text: representativeThreadMessage.text,
          blockedAt: representativeCustomer.blockedAt,
          identityId: representativeCustomerIdentity.id,
          optedOutAt: representativeCustomerIdentity.optedOutAt,
        })
        .from(decision)
        .innerJoin(
          representativeThreadMessage,
          eq(representativeThreadMessage.id, decision.messageId),
        )
        .innerJoin(representativeThread, eq(representativeThread.id, decision.threadId))
        .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
        .innerJoin(
          representativeCustomer,
          eq(representativeCustomer.id, representativeThread.customerId),
        )
        .leftJoin(
          representativeCustomerIdentity,
          and(
            eq(representativeCustomerIdentity.customerId, representativeThread.customerId),
            eq(representativeCustomerIdentity.channel, decision.channel),
            eq(representativeCustomerIdentity.externalId, decision.externalId),
          ),
        )
        .where(eq(decision.id, decisionId));
      if (!row) return;
      // Only what passes the gate's opt-out rule is held to it: the rest is meant for them regardless.
      const optional = rulesOf[row.kind].includes("optedOut");
      const stopped = row.blockedAt
        ? notDelivered.blocked
        : !row.identityId
          ? notDelivered.moved
          : row.optedOutAt && optional
            ? notDelivered.optedOut
            : optional && (await job.isUserBlocked(row.userId))
              ? notDelivered.banned
              : null;
      if (stopped) {
        await logNotDelivered(job, decisionId, stopped, job.clock());
        return;
      }
      // The parts of one message stay together, wherever the Customer has written since.
      const channelAccountId = row.sentOn ? row.sentOn.channelAccountId : row.channelAccountId;
      try {
        await channelOf(job).send(
          { channel: row.channel, externalId: row.externalId },
          { text: row.text },
          {
            representativeId: row.representativeId,
            channelAccountId,
            resume: row.sentOn?.progress ?? null,
          },
        );
      } catch (error) {
        if (error instanceof MessagingSendError) {
          // Without it, the retry sends the parts already sent again, or on another account.
          const sentThrough =
            error instanceof AccountSendError ? error.channelAccountId : channelAccountId;
          await job.db
            .update(decision)
            .set({ sentOn: { channelAccountId: sentThrough, progress: error.progress } })
            .where(eq(decision.id, decisionId))
            .catch((saving: unknown) =>
              job.logger.error("Saving a send's progress failed", saving),
            );
        }
        throw error;
      }
      hintVisitor(job, row);
    },
    onFailed: ({ decisionId }, _error, job) =>
      logNotDelivered(job, decisionId, notDelivered.failed, job.clock()),
  });

/** Every decision on the threads of `userId`'s Representatives, with what each held. */
export async function exportOutboundDecisions(tx: Transaction, userId: string) {
  const decision = representativeOutboundDecision;
  const held = representativeHeldMessage;
  return tx
    .select({
      threadId: decision.threadId,
      kind: decision.kind,
      outcome: decision.outcome,
      rule: decision.rule,
      releaseId: decision.releaseId,
      channel: decision.channel,
      externalId: decision.externalId,
      messageId: decision.messageId,
      heldText: held.text,
      heldTopic: held.topic,
      heldResolution: held.resolution,
      createdAt: decision.createdAt,
    })
    .from(decision)
    .innerJoin(representativeThread, eq(representativeThread.id, decision.threadId))
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .leftJoin(held, eq(held.decisionId, decision.id))
    .where(eq(representative.userId, userId))
    .orderBy(asc(decision.id));
}
