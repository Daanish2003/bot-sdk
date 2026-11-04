import { and, asc, eq, gt, isNull, max, or, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import type { ReplyDraftView } from "../shared/contract";
import { nameIn, profilesOf } from "./customer-profile";
import type { Heard } from "./customers";
import {
  draftRule,
  type HeldResolution,
  representative,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import {
  dropHeld,
  type GateRefusal,
  holdForRules,
  outdatedBy,
  passGate,
  type Sender,
  storeAndDeliver,
} from "./outbound-gate";

/*
 * Reply drafts (ticket #1306): a reply the Outbound gate's `topic` rule held, which goes only when
 * the owner says. The Customer gets one fixed holding note at once, until they next write. A Customer
 * message replaces what waits, so nothing out of date can be approved. All of it happens under the
 * thread's row lock, which a message arriving and a reply being written take too.
 */

type Context = Pick<FeatureContext, "db" | "clock" | "jobs">;

/** What a Customer gets while a Reply draft waits for the owner. */
export const holdingNote =
  "Thanks for your message. Someone from our team is checking the answer and will reply here soon.";

const held = representativeHeldMessage;
const decision = representativeOutboundDecision;
const message = representativeThreadMessage;
const thread = representativeThread;

/** The most drafts the owner's list shows at once; answering the oldest brings the next. */
const replyDraftListLimit = 200;

const replyDraftNotFound = () =>
  rpcError("NOT_FOUND", "error.replyDraftNotFound", "Draft not found");
const replyDraftGone = () =>
  rpcError("CONFLICT", "error.replyDraftGone", "This draft is no longer waiting");
const replyDraftNotSent = () =>
  rpcError(
    "CONFLICT",
    "error.replyDraftNotSent",
    "This draft can't be sent now: the thread may be held or closed, the Customer blocked, or the Representative switched off",
  );

/** Whether something the gate held waits on the thread, for a query over threads. */
export const heldWaitingQuery = sql`exists (select 1 from ${held} where ${held.threadId} = ${thread.id} and ${held.resolution} is null)`;

/**
 * Replaces what waits on the thread, whose row `tx` holds, that a newer word from `by` puts out of
 * date, whichever rule held it. With no `by`, all of it, on a thread closing.
 */
export async function replaceHeld(tx: Transaction, threadId: string, now: Date, by?: Sender) {
  await dropHeld(tx, { threadId, by, kind: "reply", rule: "replaced", now });
  const waiting = tx
    .select({ id: held.id })
    .from(held)
    .innerJoin(decision, eq(decision.id, held.decisionId))
    .where(
      and(
        eq(held.threadId, threadId),
        isNull(held.resolution),
        eq(decision.rule, draftRule),
        by && outdatedBy(by),
      ),
    );
  await tx
    .update(held)
    .set({ resolution: "replaced", resolvedAt: now })
    .where(sql`${held.id} in ${waiting}`);
}

/** Who a Turn's batch came from, by the position it starts at. */
export async function turnSender(
  tx: Transaction,
  threadId: string,
  turnFrom: number,
): Promise<Sender | undefined> {
  const [sender] = await tx
    .select({
      channel: message.channel,
      externalId: message.externalId,
      verified: message.verified,
    })
    .from(message)
    .where(and(eq(message.threadId, threadId), eq(message.position, turnFrom)));
  return sender;
}

/** Whether a word from `by` answers, or outdates, what was meant for `to`. */
const speaksFor = (by: Sender, to: Sender) =>
  (by.channel === to.channel && by.externalId === to.externalId) || (by.verified && to.verified);

/**
 * Whether a Customer's message newer than position `upTo` makes a reply to `to` out of date, the same
 * way a message arriving after it would have: the next Turn answers both.
 */
async function overtaken(tx: Transaction, threadId: string, upTo: number, to: Sender) {
  const [newer] = await tx
    .select({ position: message.position })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        eq(message.author, "customer"),
        gt(message.position, upTo),
        or(
          to.verified ? eq(message.verified, true) : undefined,
          and(eq(message.channel, to.channel), eq(message.externalId, to.externalId)),
        ),
      ),
    )
    .limit(1);
  return newer !== undefined;
}

/** Whether a holding note has gone to the address since it last wrote. */
async function notedSinceCustomer(tx: Transaction, threadId: string, to: Heard) {
  const [last] = await tx
    .select({ position: max(message.position) })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        eq(message.author, "customer"),
        eq(message.channel, to.channel),
        eq(message.externalId, to.externalId),
      ),
    );
  const [note] = await tx
    .select({ id: decision.id })
    .from(decision)
    .innerJoin(message, eq(message.id, decision.messageId))
    .where(
      and(
        eq(decision.threadId, threadId),
        eq(decision.kind, "holding_note"),
        eq(decision.channel, to.channel),
        eq(decision.externalId, to.externalId),
        gt(message.position, last?.position ?? 0),
      ),
    )
    .limit(1);
  return note !== undefined;
}

/**
 * What follows a reply the gate has just held as a Reply draft, in its transaction. A Customer
 * message that came while its Turn ran may have outdated it already. Otherwise the address gets the
 * holding note, through the gate, if it hasn't had one since it last wrote.
 */
export async function afterDraftHeld(
  services: Pick<Context, "jobs">,
  tx: Transaction,
  {
    decisionId,
    threadId,
    upTo,
    heard,
    verified,
    releaseId,
    refusals,
  }: {
    decisionId: string;
    threadId: string;
    upTo: number;
    heard: Heard;
    verified: boolean;
    releaseId?: string | null;
    refusals?: GateRefusal[];
  },
  now: Date,
) {
  if (await overtaken(tx, threadId, upTo, { ...heard, verified })) {
    await tx
      .update(held)
      .set({ resolution: "replaced", resolvedAt: now })
      .where(eq(held.decisionId, decisionId));
    return;
  }
  if (await notedSinceCustomer(tx, threadId, heard)) return;
  const noted = await passGate(tx, {
    kind: "holding_note",
    threadId,
    to: heard,
    now,
    releaseId,
    refusals,
    content: { text: holdingNote, verified },
  });
  if (noted?.outcome !== "send") return;
  const note = { threadId, author: "note", text: holdingNote, verified, ...heard } as const;
  await storeAndDeliver(services, tx, noted.id, note, now);
}

/** The thread of one of the owner's Reply drafts, or "not found", read before any lock. */
async function draftThread(tx: Transaction, userId: string, id: string) {
  const [found] = await tx
    .select({ threadId: held.threadId })
    .from(held)
    .innerJoin(decision, eq(decision.id, held.decisionId))
    .innerJoin(thread, eq(thread.id, held.threadId))
    .innerJoin(representative, eq(representative.id, thread.representativeId))
    .where(and(eq(held.id, id), eq(representative.userId, userId), eq(decision.rule, draftRule)));
  if (!found) throw replyDraftNotFound();
  return found.threadId;
}

/**
 * Holds what a Reply draft's answer depends on, in the order the gate's rules take it, and reads the
 * draft: gone once anything has answered it.
 */
async function holdDraft(tx: Transaction, userId: string, id: string) {
  const threadId = await draftThread(tx, userId, id);
  if (!(await holdForRules(tx, threadId))) throw replyDraftNotFound();
  const [draft] = await tx
    .select({
      text: held.text,
      verified: held.verified,
      replyKind: held.replyKind,
      sources: held.sources,
      topic: held.topic,
      channel: decision.channel,
      externalId: decision.externalId,
      releaseId: decision.releaseId,
    })
    .from(held)
    .innerJoin(decision, eq(decision.id, held.decisionId))
    .where(and(eq(held.id, id), isNull(held.resolution)));
  if (!draft) throw replyDraftGone();
  return { threadId, draft };
}

const resolve = (
  tx: Transaction,
  id: string,
  resolution: HeldResolution,
  now: Date,
  messageId: string | null = null,
) => tx.update(held).set({ resolution, resolvedAt: now, messageId }).where(eq(held.id, id));

/**
 * Sends the owner's Reply draft through the gate. Words they changed are theirs, resting on nothing
 * the Representative's did. Refused, and still waiting, when the gate drops it: it can go once what
 * stopped it has lifted. One the gate holds for another rule has had its answer, and waits as that
 * rule's held message. The caps aren't such a rule: the owner has just said to send it.
 */
async function sendDraft(context: Context, userId: string, id: string, words?: string) {
  const dropped = await context.db.transaction(async (tx) => {
    const { threadId, draft } = await holdDraft(tx, userId, id);
    const now = context.clock();
    const edited = words !== undefined && words !== draft.text;
    const text = edited ? words : draft.text;
    const { channel, externalId, verified, topic, releaseId } = draft;
    const replyKind = edited ? null : draft.replyKind;
    const sources = edited ? null : draft.sources;
    const heard = { channel, externalId };
    const passed = await passGate(tx, {
      kind: "reply_draft",
      threadId,
      to: heard,
      now,
      releaseId,
      content: {
        text,
        verified,
        replyKind: replyKind ?? undefined,
        sources: sources ?? undefined,
        topic: topic ?? undefined,
      },
    });
    if (passed?.outcome !== "send" && passed?.outcome !== "hold") return true;
    const author = edited ? "owner" : "representative";
    const messageId =
      passed.outcome === "send"
        ? await storeAndDeliver(
            context,
            tx,
            passed.id,
            { threadId, author, text, verified, replyKind, sources, ...heard },
            now,
            await answeredBatch(tx, threadId, { ...heard, verified }),
          )
        : null;
    await resolve(tx, id, edited ? "edited" : "approved", now, messageId);
    return false;
  });
  // After the commit, so the decision stays in the log.
  if (dropped) throw replyDraftNotSent();
}

/** What sending a reply to `to` changes of a Turn still running: it has answered that Turn's batch. */
async function answeredBatch(tx: Transaction, threadId: string, to: Sender) {
  const [row] = await tx
    .select({ turnFrom: thread.turnFrom })
    .from(thread)
    .where(eq(thread.id, threadId));
  if (row?.turnFrom == null) return {};
  const sender = await turnSender(tx, threadId, row.turnFrom);
  return sender && speaksFor(sender, to) ? { turnFrom: null } : {};
}

export const approveReplyDraft = (context: Context, userId: string, id: string) =>
  sendDraft(context, userId, id);

export const editReplyDraft = (context: Context, userId: string, id: string, text: string) =>
  sendDraft(context, userId, id, text);

/** Rejects the owner's Reply draft: nothing is sent. */
export async function rejectReplyDraft(context: Context, userId: string, id: string) {
  await context.db.transaction(async (tx) => {
    await holdDraft(tx, userId, id);
    await resolve(tx, id, "rejected", context.clock());
  });
}

/**
 * The owner's Reply drafts that can be answered now, oldest first. Not those on a thread they hold,
 * which come back if they hand it back without writing, nor those on a closed thread.
 */
export async function listReplyDrafts(
  { db }: Pick<Context, "db">,
  userId: string,
): Promise<ReplyDraftView[]> {
  const rows = await db
    .select({
      id: held.id,
      threadId: held.threadId,
      representativeId: thread.representativeId,
      customerId: thread.customerId,
      text: held.text,
      topic: held.topic,
      kind: held.replyKind,
      sources: held.sources,
      verified: held.verified,
      channel: decision.channel,
      externalId: decision.externalId,
      createdAt: held.createdAt,
    })
    .from(held)
    .innerJoin(decision, eq(decision.id, held.decisionId))
    .innerJoin(thread, eq(thread.id, held.threadId))
    .innerJoin(representative, eq(representative.id, thread.representativeId))
    .where(
      and(
        eq(representative.userId, userId),
        eq(decision.rule, draftRule),
        isNull(held.resolution),
        eq(thread.state, "representative"),
      ),
    )
    .orderBy(asc(held.id))
    .limit(replyDraftListLimit);
  const profiles = await profilesOf(db, userId, [...new Set(rows.map((row) => row.customerId))]);
  return rows.map(({ customerId, channel, externalId, kind, sources, ...row }) => ({
    ...row,
    customerName: nameIn(profiles.get(customerId)),
    to: { channel, externalId },
    reply: { kind, sources: sources ?? [] },
  }));
}
