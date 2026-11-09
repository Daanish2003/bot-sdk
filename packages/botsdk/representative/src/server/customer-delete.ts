import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  max,
  min,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { holdCustomers, isMergedAway } from "./customer-merge";
import { memberIds, standingMergesOf } from "./customer-profile";
import { fixedReplyKinds } from "../shared/replies";
import { holdIdentities, smsChannel } from "./customer-proof";
import { customerSummaryKey } from "./customer-summary";
import type { Heard } from "./customers";
import {
  representativeCall,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeCustomerMerge,
  representativeCustomerSummary,
  representativeHandOff,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import { threadExpiryKey } from "./expiry";
import { customerNotFound } from "./owner-customers";
import { queueWaitingTurn } from "./thread-turns";
import { hintVisitor } from "./visitor-hints";

/*
 * Deleting a Customer (ticket #1287, spec #1170, ADR 0035): a hard delete, of them and everyone merged
 * into them, whose rows hold values the survivor reads. Foreign keys take most of it. What they can't
 * reach is here: queued jobs, the merge history that stores ids in JSON, and what an undone merge left
 * of this person on the other Customer's thread. Spend rows stay: they name no Customer. A job's
 * Checkpoints and a Gap's question stay too, the limits ADR 0035 documents, and a lesson proposal
 * names no Customer. What a Bot's records hold of their Assignments is redacted by reference (#1288).
 */

type Context = Pick<
  FeatureContext<"assignments" | "pubsub" | "threads">,
  "db" | "clock" | "jobs" | "assignments" | "logger" | "pubsub" | "threads"
>;

/**
 * Holds the owner's Customer and everyone merged into them, and returns their ids. A merge moving as
 * this waits is seen on the next read, and locking what it added late can at worst fail this delete on
 * a deadlock, which changes nothing.
 */
async function holdCustomerAndMerged(tx: Transaction, userId: string, id: string) {
  const held = new Set<string>();
  for (let next = [id]; ;) {
    const rows = await holdCustomers(tx, next);
    if (!held.has(id) && rows[0]?.userId !== userId) throw customerNotFound();
    for (const row of rows) held.add(row.id);
    if (await isMergedAway(tx, id)) throw customerNotFound();
    const members = memberIds(await standingMergesOf(tx, userId), id);
    if (members.every((each) => held.has(each))) return members;
    next = members.filter((each) => !held.has(each));
  }
}

const isAt = (channel: AnyPgColumn, externalId: AnyPgColumn, addresses: Heard[]): SQL =>
  or(...addresses.map((each) => and(eq(channel, each.channel), eq(externalId, each.externalId))))!;

/** A deleted thread's work: a queued Turn and expiry never run, and a running Turn stops at its fence. */
async function cancelThreadJobs(
  tx: Transaction,
  { jobs }: Context,
  thread: { id: string; turnId: string | null },
) {
  if (thread.turnId) await jobs.cancelIn(tx, thread.turnId);
  await jobs.cancelIn(tx, threadExpiryKey(thread.id));
}

/**
 * What was waiting on `thread`, whose row `tx` holds, after someone's messages left it: the wait starts
 * at what's left, or ends. A Turn on their batch goes. So does one with no batch: a queued one would
 * find nothing where its wait began, and one past its first reply can't be told apart from it and may
 * have been answering them. A Turn on someone else's batch carries on, and what still waits gets a new
 * Turn in place of one that went.
 */
async function settleThreadWait(
  tx: Transaction,
  context: Context,
  thread: {
    id: string;
    turnId: string | null;
    turnFrom: number | null;
    waitingFrom: number | null;
  },
) {
  const message = representativeThreadMessage;
  const { id, turnId, turnFrom, waitingFrom } = thread;
  const [next] =
    waitingFrom === null
      ? []
      : await tx
          .select({ position: min(message.position) })
          .from(message)
          .where(
            and(
              eq(message.threadId, id),
              inArray(message.author, ["customer", "bot"]),
              gte(message.position, waitingFrom),
            ),
          );
  const waiting = next?.position ?? null;
  const [batch] =
    turnFrom === null
      ? []
      : await tx
          .select({ position: message.position })
          .from(message)
          .where(and(eq(message.threadId, id), eq(message.position, turnFrom)));
  const turnGoes = turnId !== null && batch === undefined;
  if (turnGoes) await context.jobs.cancelIn(tx, turnId);
  // What a limit left for the owner is owed still if anyone's words have had no answer since. Code's
  // fixed words are no answer: each only says someone will reply. A note at a limit is owed only while
  // something waits.
  const [answered] = await tx
    .select({ position: max(message.position) })
    .from(message)
    .where(
      and(
        eq(message.threadId, id),
        inArray(message.author, ["representative", "owner"]),
        or(isNull(message.replyKind), notInArray(message.replyKind, [...fixedReplyKinds])),
      ),
    );
  const unanswered = await tx
    .select({ position: message.position })
    .from(message)
    .where(
      and(
        eq(message.threadId, id),
        inArray(message.author, ["customer", "bot"]),
        gt(message.position, answered?.position ?? 0),
      ),
    )
    .limit(1);
  await tx
    .update(representativeThread)
    .set({
      waitingFrom: waiting,
      ...(waiting === null && { waitingSince: null, limitNotedAt: null }),
      ...(unanswered.length === 0 && { leftForOwnerAt: null }),
      ...(turnGoes && { turnId: null, turnFrom: null }),
    })
    .where(eq(representativeThread.id, id));
  if (turnGoes && waiting !== null) await queueWaitingTurn(context, tx, id);
}

/**
 * A merge that was undone can leave this person's words on another Customer's thread, since nothing
 * moved back but the thread and identities that the merge moved. Later merges can have taken that
 * thread further, so it is found by their address, across the owner's other Customers. Those words, and
 * any summary made from them or pass about to make one, go; so does a hand-off from them, whose
 * Assignment is returned for redaction. The other Customer's own words stay, and a thread with none
 * left goes. One that stays stops waiting on them. Gate decisions at their address go too, what they
 * held with them, as a proof can be addressed to them from any thread. Returns the threads it removed,
 * and those Assignments.
 */
async function removeFromOtherThreads(
  tx: Transaction,
  context: Context,
  userId: string,
  customerIds: string[],
  addresses: Heard[],
): Promise<{ threadIds: string[]; assignmentIds: string[] }> {
  if (addresses.length === 0) return { threadIds: [], assignmentIds: [] };
  const thread = representativeThread;
  const message = representativeThreadMessage;
  const isTheirs = isAt(message.channel, message.externalId, addresses);
  const others = tx
    .select({ id: representativeCustomer.id })
    .from(representativeCustomer)
    .where(
      and(
        eq(representativeCustomer.userId, userId),
        notInArray(representativeCustomer.id, customerIds),
      ),
    );
  const touched = await tx
    .selectDistinct({ id: thread.id })
    .from(thread)
    .innerJoin(message, eq(message.threadId, thread.id))
    .where(and(inArray(thread.customerId, others), isTheirs));
  const threadIds: string[] = [];
  for (const { id } of touched) {
    const [each] = await tx
      .select({
        id: thread.id,
        turnId: thread.turnId,
        turnFrom: thread.turnFrom,
        waitingFrom: thread.waitingFrom,
        lastChannel: thread.lastChannel,
        lastExternalId: thread.lastExternalId,
      })
      .from(thread)
      .where(eq(thread.id, id))
      .for("update");
    if (!each) continue;
    const { lastChannel, lastExternalId } = each;
    await tx.delete(message).where(and(eq(message.threadId, id), isTheirs));
    await context.jobs.cancelIn(tx, customerSummaryKey(id));
    await tx
      .delete(representativeCustomerSummary)
      .where(eq(representativeCustomerSummary.threadId, id));
    const [newest] = await tx
      .select({ channel: message.channel, externalId: message.externalId })
      .from(message)
      .where(eq(message.threadId, id))
      .orderBy(desc(message.position))
      .limit(1);
    if (!newest) {
      await cancelThreadJobs(tx, context, each);
      await tx.delete(thread).where(eq(thread.id, id));
      threadIds.push(id);
      continue;
    }
    await settleThreadWait(tx, context, each);
    if (addresses.some((one) => one.channel === lastChannel && one.externalId === lastExternalId)) {
      await tx
        .update(thread)
        // Which account that address wrote to isn't kept, so the oldest answers until it writes again.
        .set({
          lastChannel: newest.channel,
          lastExternalId: newest.externalId,
          channelAccountId: null,
        })
        .where(eq(thread.id, id));
    }
  }
  // A Call of theirs left on one of those threads names their number; its entry went with their words.
  const numbers = addresses.filter((each) => each.channel === smsChannel);
  if (numbers.length > 0) {
    await tx.delete(representativeCall).where(
      and(
        inArray(
          representativeCall.threadId,
          tx.select({ id: thread.id }).from(thread).where(inArray(thread.customerId, others)),
        ),
        inArray(
          representativeCall.externalId,
          numbers.map((each) => each.externalId),
        ),
      ),
    );
  }
  const decision = representativeOutboundDecision;
  await tx
    .delete(decision)
    .where(
      and(
        inArray(
          decision.threadId,
          tx.select({ id: thread.id }).from(thread).where(inArray(thread.customerId, others)),
        ),
        isAt(decision.channel, decision.externalId, addresses),
      ),
    );
  const handOff = representativeHandOff;
  const handOffs = await tx
    .delete(handOff)
    .where(
      and(
        inArray(handOff.customerId, others),
        isAt(handOff.channel, handOff.externalId, addresses),
      ),
    )
    .returning({ assignmentId: handOff.assignmentId });
  return { threadIds, assignmentIds: handOffs.map((row) => row.assignmentId) };
}

/**
 * The mirror of the above: an undo can leave these Customers holding a hand-off that came from another
 * Customer's address, on a thread that moved back. It is theirs, so it goes to them rather than with
 * this delete. Its thread goes, so no reply is sent, and they read its result on a later verified Turn.
 */
async function giveBackHandOffs(tx: Transaction, userId: string, customerIds: string[]) {
  const handOff = representativeHandOff;
  const identity = representativeCustomerIdentity;
  const heldForOthers = await tx
    .select({ assignmentId: handOff.assignmentId, customerId: identity.customerId })
    .from(handOff)
    .innerJoin(
      identity,
      and(
        eq(identity.userId, userId),
        eq(identity.channel, handOff.channel),
        eq(identity.externalId, handOff.externalId),
      ),
    )
    .where(
      and(inArray(handOff.customerId, customerIds), notInArray(identity.customerId, customerIds)),
    );
  for (const { assignmentId, customerId } of heldForOthers) {
    await tx.update(handOff).set({ customerId }).where(eq(handOff.assignmentId, assignmentId));
  }
}

/**
 * Hard-deletes the owner's Customer and everyone merged into them, and redacts the Assignments their
 * hand-offs named, in the same transaction since nothing else can find those once the hand-offs have
 * gone, and returns them. A message waiting on these rows finds no identity afterwards, and comes
 * from a stranger. Queued Turns, passes and expiries are cancelled. A
 * running Turn's writes are refused by its fence, and a thread's idle check, whose key holds its due
 * date, and a hand-off's result both run and find nothing.
 */
export async function deleteCustomer(
  context: Context,
  userId: string,
  id: string,
): Promise<{ assignmentIds: string[] }> {
  const done = await context.db.transaction(async (tx) => {
    const customerIds = await holdCustomerAndMerged(tx, userId, id);
    const identity = representativeCustomerIdentity;
    const identities = await tx
      .select({ id: identity.id, channel: identity.channel, externalId: identity.externalId })
      .from(identity)
      .where(inArray(identity.customerId, customerIds));
    await holdIdentities(
      tx,
      identities.map((each) => each.id),
    );
    const threads = await tx
      .select({ id: representativeThread.id, turnId: representativeThread.turnId })
      .from(representativeThread)
      .where(inArray(representativeThread.customerId, customerIds))
      .for("update");
    for (const thread of threads) {
      await cancelThreadJobs(tx, context, thread);
      await context.jobs.cancelIn(tx, customerSummaryKey(thread.id));
    }

    const merge = representativeCustomerMerge;
    const merges = await tx.select().from(merge).where(eq(merge.userId, userId));
    const fromOthers = await removeFromOtherThreads(tx, context, userId, customerIds, identities);
    await giveBackHandOffs(tx, userId, customerIds);
    const handOffs = await tx
      .select({ assignmentId: representativeHandOff.assignmentId })
      .from(representativeHandOff)
      .where(inArray(representativeHandOff.customerId, customerIds));
    const assignmentIds = [...handOffs.map((row) => row.assignmentId), ...fromOthers.assignmentIds];

    // A merge of these Customers goes with them. Another's can still hold their ids in JSON, from when
    // they had been merged into one of its two: an undone one goes, as nothing can use it again, and
    // one that stands stays without those ids, as the owner can still undo it.
    const gone = new Set([
      ...identities.map((each) => each.id),
      ...threads.map((each) => each.id),
      ...fromOthers.threadIds,
      ...assignmentIds,
    ]);
    const kept = (ids: string[]) => ids.filter((each) => !gone.has(each));
    for (const row of merges) {
      const held = [
        ...row.identityIds,
        ...row.threadIds,
        ...row.handOffIds,
        ...row.movedHolds.flatMap((hold) => [hold.closedThreadId, hold.survivingThreadId]),
      ];
      if (!held.some((each) => gone.has(each))) continue;
      if (row.undoneAt) {
        await tx.delete(merge).where(eq(merge.id, row.id));
        continue;
      }
      await tx
        .update(merge)
        .set({
          identityIds: kept(row.identityIds),
          threadIds: kept(row.threadIds),
          handOffIds: kept(row.handOffIds),
          movedHolds: row.movedHolds.filter(
            (hold) => !gone.has(hold.closedThreadId) && !gone.has(hold.survivingThreadId),
          ),
        })
        .where(eq(merge.id, row.id));
    }

    await tx.delete(representativeCustomer).where(inArray(representativeCustomer.id, customerIds));
    // Last, as this feature's locks come before a Conversation's.
    const { conversationIds } = await context.assignments.redact(tx, {
      userId,
      ids: assignmentIds,
    });
    return { assignmentIds, conversationIds, identities };
  });
  context.jobs.wake();
  for (const identity of done.identities) hintVisitor(context, identity);
  for (const conversationId of done.conversationIds) {
    await context.threads.hintChanged(conversationId);
  }
  return { assignmentIds: done.assignmentIds };
}
