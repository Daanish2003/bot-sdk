import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { defineJob } from "@botsdk/bot/runner/internal";
import type { ReplySource, StoredReplyKind } from "../shared/replies";
import { type CustomerChannel } from "./customer-proof";
import { holdThreadCustomer } from "./customers";
import {
  type GateOutcome,
  type OutboundKind,
  representative,
  representativeCustomer,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";

/*
 * The Outbound gate (ticket #1298): one code-owned check of every message to a Customer, in a fixed
 * order. The first rule that fails decides, and every decision is logged with its rule and Release,
 * in the transaction of the message's own write. A Model has no say in it. A message the gate sends
 * goes to the Channel by a job queued in that transaction, so it survives a crash and a Channel's
 * failure, and a replay of a Turn sends nothing twice.
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
  owner: ["blocked", "optedOut", "channel"],
  takeover_note: ["blocked", "optedOut", "channel"],
  proof: ["blocked", "optedOut", "channel"],
};

/** What the rules read of a message's thread. */
type GateFacts = {
  threadState: string;
  blockedAt: Date | null;
  enabled: boolean;
};

export type GateCheck = (facts: GateFacts) => Exclude<GateOutcome, "send"> | null;

/** The rules that exist. Each ticket adds its rule here. */
export const liveChecks: Partial<Record<GateRule, GateCheck>> = {
  held: ({ threadState }) => (threadState === "representative" ? null : "drop"),
  blocked: ({ blockedAt }) => (blockedAt === null ? null : "drop"),
  on: ({ enabled }) => (enabled ? null : "drop"),
};

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
  /** What is held if the gate holds it. A proof has none: its secret is never stored. */
  content?: {
    text: string;
    verified: boolean;
    replyKind?: StoredReplyKind;
    sources?: ReplySource[];
  };
};

export type GateDecision = { id: string; outcome: GateOutcome; rule: string };

/**
 * Takes the locks a rule on the thread needs, in the order the owner's changes take them: the
 * Representative's row, in a mode any number of Turns can hold, then the Customer's, then the
 * thread's. A switch-off, a block or a takeover then lands either before this decision or after this
 * transaction's message. False when the thread has gone.
 */
async function holdForRules(tx: Transaction, threadId: string) {
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
 * Decides what becomes of `outgoing` and logs it, in `tx`. A held message is stored here; a sent one
 * the caller stores in its thread, and then hands to `deliverMessage`. Null when the thread has gone,
 * so there's nothing to log it on and nothing is sent. The owner's paths hold the thread before this,
 * and a proof takes no lock here, since it runs under the holds on its identities.
 */
export async function passGate(
  tx: Transaction,
  outgoing: Outgoing,
  checks: Partial<Record<GateRule, GateCheck>> = liveChecks,
): Promise<GateDecision | null> {
  const { kind, threadId, to, now, content } = outgoing;
  const rules = rulesOf[kind];
  if (rules.includes("held") && !(await holdForRules(tx, threadId))) return null;
  const [row] = await tx
    .select({
      threadState: representativeThread.state,
      customerId: representativeThread.customerId,
      enabled: representative.enabled,
      liveReleaseId: representative.liveReleaseId,
    })
    .from(representativeThread)
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .where(eq(representativeThread.id, threadId));
  if (!row) return null;
  const [customer] = await tx
    .select({ blockedAt: representativeCustomer.blockedAt })
    .from(representativeCustomer)
    .where(eq(representativeCustomer.id, outgoing.customerId ?? row.customerId));
  const facts: GateFacts = { ...row, blockedAt: customer?.blockedAt ?? null };

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
  await tx.insert(representativeOutboundDecision).values({
    id,
    threadId,
    kind,
    outcome,
    rule,
    releaseId: outgoing.releaseId ?? row.liveReleaseId,
    channel: to.channel,
    externalId: to.externalId,
    createdAt: now,
  });
  if (outcome === "hold" && content) {
    await tx.insert(representativeHeldMessage).values({
      id: uuidv7(),
      decisionId: id,
      threadId,
      text: content.text,
      verified: content.verified,
      replyKind: content.replyKind,
      sources: content.sources,
      createdAt: now,
    });
  }
  return { id, outcome, rule };
}

export const customerDeliveryJobName = "representative.customer-delivery";

/** Only the decision: its words stay in the thread, and go with it. */
const deliveryPayload = z.object({ decisionId: z.uuid() });
const deliveryJob = { name: customerDeliveryJobName, payload: deliveryPayload };

/**
 * Sends the thread message `messageId` that decision `decisionId` passed, once `tx` commits. Each
 * message has its own job, so one the Channel fails can go after a later one on its retry.
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

/** Sends what the gate passed. A throw is the runner's to retry; a thread deleted since sends nothing. */
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
        })
        .from(decision)
        .innerJoin(
          representativeThreadMessage,
          eq(representativeThreadMessage.id, decision.messageId),
        )
        .where(eq(decision.id, decisionId));
      if (!row) return;
      await channel.send({ channel: row.channel, externalId: row.externalId }, { text: row.text });
    },
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
      createdAt: decision.createdAt,
    })
    .from(decision)
    .innerJoin(representativeThread, eq(representativeThread.id, decision.threadId))
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .leftJoin(held, eq(held.decisionId, decision.id))
    .where(eq(representative.userId, userId))
    .orderBy(asc(decision.id));
}
