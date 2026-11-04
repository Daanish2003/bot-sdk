import { and, asc, count, eq, gt, inArray, isNull, max, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { defineJob } from "@botsdk/bot/runner/internal";
import { limitNoteKind, type ReplySource, type StoredReplyKind } from "../shared/replies";
import { type CustomerChannel } from "./customer-proof";
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

/*
 * The Outbound gate (ticket #1298): one code-owned check of every message to a Customer, in a fixed
 * order. The first rule that fails decides, and every decision is logged with its rule and Release,
 * in the transaction of the message's own write. A Model has no say in it. A message the gate sends
 * goes to the Channel by a job queued in that transaction, so it survives a crash and a Channel's
 * brief failure, and a replay of a Turn queues nothing twice.
 */

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

/** Which rules each message passes: the takeover note, say, would otherwise be refused by its own thread. */
const rulesOf: Record<OutboundKind, readonly GateRule[]> = {
  reply: gateOrder,
  code_hand_off: ["held", "blocked", "optedOut", "on", "channel"],
  limit_note: ["held", "blocked", "optedOut", "on", "channel"],
  owner: ["blocked", "optedOut", "channel"],
  released: ["blocked", "optedOut", "channel"],
  takeover_note: ["blocked", "optedOut", "channel"],
  proof: ["blocked", "optedOut", "channel"],
  // All a reply passes but these: the owner's word settles them for a draft, as for a released
  // message, and the note is code's, which isn't what the caps count.
  holding_note: gateOrder.filter((rule) => rule !== "topic" && rule !== "caps"),
  reply_draft: gateOrder.filter((rule) => rule !== "topic" && rule !== "caps"),
};

/** What the rules read of a message's thread. */
type GateFacts = {
  threadState: string;
  blockedAt: Date | null;
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
  on: ({ enabled }) => (enabled ? null : "drop"),
  topic: ({ topicMode, sourcesOnTopic }) =>
    topicMode === "auto" && sourcesOnTopic ? null : "hold",
  caps: ({ sentInARow, sentToday, maxInARow, maxPerDay }) =>
    sentInARow >= maxInARow || sentToday >= maxPerDay ? "hold" : null,
  quietHours: ({ businessStarted, quiet }) => (businessStarted && quiet ? "hold" : null),
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
   * The id of the held message this is the automatic release of: it also passes `on`, `caps` and the topic, and
   * holding it again writes no second held row. A Page for it counts the other held messages only.
   */
  releasing?: string;
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
    ? [...rulesOf[kind], "on", "caps", "topic"]
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
  const facts: GateFacts = {
    ...row,
    businessStarted,
    quiet: isQuiet(now, timeZone, period),
    blockedAt: customer?.blockedAt ?? null,
    topicMode,
    // Only an auto topic can send, so only then does it matter.
    sourcesOnTopic:
      topicMode === "auto" &&
      (await sourcesBelongToLabel(tx, row.userId, content?.topic, content?.sources)),
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
      text: `The Outbound gate held a message from ${row.name} to a Customer (rule: ${rule}). Open the thread to send or drop it.`,
      path: `/representatives/${row.representativeId}`,
    };
  }
  await writeDecision(tx, written, outgoing.pages, outgoing.jobs);
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
 * its first decision stays in the log. A Reply draft has its own answers, and stays (`reply-drafts`).
 */
export async function dropHeld(
  tx: Transaction,
  {
    threadId,
    heldId,
    by,
    kind,
    rule,
    now,
  }: {
    threadId: string;
    heldId?: string;
    by?: Sender;
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
        heldId ? eq(held.id, heldId) : undefined,
        by && outdatedBy(by),
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
const notDelivered = { failed: "delivery_failed", blocked: "blocked", moved: "address_changed" };

/** Logs that the message `decisionId` passed didn't go after all. */
async function logNotDelivered(
  db: FeatureContext["db"],
  decisionId: string,
  rule: string,
  now: Date,
) {
  await db.transaction(async (tx) => {
    const [passed] = await tx
      .select()
      .from(representativeOutboundDecision)
      .where(eq(representativeOutboundDecision.id, decisionId));
    if (!passed) return;
    const decision = { ...passed, id: uuidv7(), outcome: "drop" as const, rule, createdAt: now };
    await writeDecision(tx, { decision });
  });
}

/**
 * Sends what the gate passed. A throw is the runner's to retry, so this can run well after the
 * decision: a Customer blocked since gets nothing, and neither does an address no longer theirs,
 * which may be someone else's. A thread deleted since sends nothing.
 */
export const customerDeliveryJob = (channel: CustomerChannel) =>
  defineJob<z.infer<typeof deliveryPayload>>({
    name: customerDeliveryJobName,
    payload: deliveryPayload,
    run: async ({ decisionId }, job) => {
      const decision = representativeOutboundDecision;
      const [row] = await job.db
        .select({
          channel: decision.channel,
          externalId: decision.externalId,
          text: representativeThreadMessage.text,
          blockedAt: representativeCustomer.blockedAt,
          identityId: representativeCustomerIdentity.id,
        })
        .from(decision)
        .innerJoin(
          representativeThreadMessage,
          eq(representativeThreadMessage.id, decision.messageId),
        )
        .innerJoin(representativeThread, eq(representativeThread.id, decision.threadId))
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
      const stopped = row.blockedAt
        ? notDelivered.blocked
        : row.identityId
          ? null
          : notDelivered.moved;
      if (stopped) {
        await logNotDelivered(job.db, decisionId, stopped, job.clock());
        return;
      }
      await channel.send({ channel: row.channel, externalId: row.externalId }, { text: row.text });
    },
    onFailed: ({ decisionId }, _error, { db, clock }) =>
      logNotDelivered(db, decisionId, notDelivered.failed, clock()),
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
