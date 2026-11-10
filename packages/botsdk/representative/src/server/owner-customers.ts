import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { endedAssignmentStatuses } from "@botsdk/client/bot/assignment";
import { botAssignment } from "@botsdk/bot/storage";
import type { FeatureContext } from "@botsdk/bot/feature";
import { isUniqueViolation } from "@botsdk/bot/lib/unique-violation";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { rpcError } from "@botsdk/bot/rpc-error";
import type { Transaction } from "@botsdk/bot/plugin";
import type {
  CallEntryView,
  CustomerView,
  ThreadHolder,
  ThreadMessageView,
  ThreadSummary,
  ThreadView,
  ThreadWaitingOn,
} from "../shared/contract";
import { codeHandOffKind, type StoredReplyKind } from "../shared/replies";
import { transcriptLines } from "./call-transcript";
import {
  representative,
  representativeCall,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeHandOff,
  draftRule,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
  type ThreadAuthor,
  type ThreadState,
} from "./db/schema";
import { isMergedAway, notMergedAway } from "./customer-merge";
import { combinedProfilesOf, nameIn, setOwnerValue } from "./customer-profile";
import { smsChannel, voidProofs } from "./customer-proof";
import { grouped } from "./customers";
import { lastMessageQuery } from "./last-message";
import { heldWaitingQuery } from "./reply-drafts";
import { isVerified } from "./verification";
import { hintVisitor } from "./visitor-hints";

/*
 * What the owner sees and does with their Customers and threads (ticket #1251). Every read and write
 * starts from the owner's id, and a Customer, identity, thread or Representative of someone else's
 * is "not found", the same as one that doesn't exist. No foreign key ties an identity's or a
 * thread's owner to its Customer's, so each write path here checks it.
 */

type Context = Pick<FeatureContext, "db" | "clock">;
type Db = Context["db"] | Transaction;

const identityAddress = "representative_customer_identity_address";

export const customerNotFound = () =>
  rpcError("NOT_FOUND", "error.customerNotFound", "Customer not found");
export const threadNotFound = () =>
  rpcError("NOT_FOUND", "error.threadNotFound", "Thread not found");
const identityTaken = () =>
  rpcError(
    "CONFLICT",
    "error.customerIdentityTaken",
    "You already have a Customer with that identity",
  );

/**
 * Who a thread is waiting on, from who holds it, who spoke last, a note aside since it answers
 * nothing, and whether a Turn holds the thread or a message waits for one, which a reply can come
 * after. A blocked Customer's message waits on no one: nothing answers it. Nor does a word on a thread
 * its Representative holds with no Turn on the way, such as a Bot's result the owner held and then
 * handed back, or what was kept during a block: only the Customer's next message gets a Turn. A
 * Customer who is owed nothing else is waiting on the Bot while an Assignment handed off from the
 * thread is open (ticket #1254), and the Bot's result waits on the owner, if they hold the thread, as
 * a Customer's message does. When the last word is code's fixed hand-off message (ticket #1261), and
 * no Bot is working on it, someone owes the Customer what it promised, and that is the owner. So is
 * a message the gate held, once no Turn is on the way that could replace it. What waits at a limit
 * waits on the owner, as no Turn can answer it, and so does what a limit left for them, once nothing
 * else is under way (ticket #1309).
 */
export function waitingOn(
  state: ThreadState,
  lastAuthor: ThreadAuthor | null,
  blocked: boolean,
  turnDue: boolean,
  botWorking = false,
  codeHandedOff = false,
  atLimit = false,
  leftForOwner = false,
  heldWaiting = false,
): ThreadWaitingOn {
  if (state === "closed" || blocked) return null;
  const speaking = lastAuthor === "customer" || lastAuthor === "bot" || lastAuthor === "call";
  if (state === "owner") {
    if (speaking || turnDue || leftForOwner) return "owner";
    if (botWorking) return "bot";
    return codeHandedOff ? "owner" : "customer";
  }
  if (atLimit) return "owner";
  if (turnDue) return "representative";
  if (botWorking) return "bot";
  if (codeHandedOff || leftForOwner || heldWaiting) return "owner";
  return speaking ? null : "customer";
}

/** `userId`'s Customers named by `ids` (all of them when omitted), oldest first, with their identities; none merged away. */
async function readCustomers(
  { db, clock }: Context,
  userId: string,
  ids?: string[],
): Promise<CustomerView[]> {
  const customers = await db
    .select()
    .from(representativeCustomer)
    .where(
      and(
        eq(representativeCustomer.userId, userId),
        notMergedAway(),
        ids ? inArray(representativeCustomer.id, ids) : undefined,
      ),
    )
    .orderBy(asc(representativeCustomer.createdAt), asc(representativeCustomer.id));
  if (customers.length === 0) return [];
  const identities = await db
    .select()
    .from(representativeCustomerIdentity)
    .where(
      and(
        eq(representativeCustomerIdentity.userId, userId),
        inArray(
          representativeCustomerIdentity.customerId,
          customers.map((customer) => customer.id),
        ),
      ),
    )
    .orderBy(asc(representativeCustomerIdentity.createdAt), asc(representativeCustomerIdentity.id));
  const now = clock();
  const byCustomer = grouped(identities, (identity) => identity.customerId);
  const profiles = await combinedProfilesOf(
    db,
    userId,
    customers.map((customer) => customer.id),
  );
  return customers.map((customer) => ({
    id: customer.id,
    name: nameIn(profiles.get(customer.id)),
    profile: profiles.get(customer.id) ?? [],
    blocked: customer.blockedAt !== null,
    createdAt: customer.createdAt,
    identities: (byCustomer.get(customer.id) ?? []).map(
      ({ id, channel, externalId, verifiedContactAt, optedOutAt, optOutSource }) => ({
        id,
        channel,
        externalId,
        verified: isVerified({ verifiedContactAt }, now),
        optedOut: optedOutAt && optOutSource ? { source: optOutSource, at: optedOutAt } : null,
      }),
    ),
  }));
}

export async function readCustomer(context: Context, userId: string, id: string) {
  const [customer] = await readCustomers(context, userId, [id]);
  if (!customer) throw customerNotFound();
  return customer;
}

/** The owner's Customers, oldest first. */
export const listCustomers = (context: Context, userId: string) => readCustomers(context, userId);

/** Adds a Customer with its first identity; the identity is the owner's already, so no Customer is made. */
export async function createCustomer(
  context: Context,
  userId: string,
  { name, channel, externalId }: { name?: string; channel: string; externalId: string },
) {
  const id = await context.db.transaction(async (tx) => {
    const customerId = uuidv7();
    await tx.insert(representativeCustomer).values({ id: customerId, userId });
    if (name) await setOwnerValue(tx, context.clock(), userId, customerId, "name", name);
    const made = await tx
      .insert(representativeCustomerIdentity)
      .values({ id: uuidv7(), userId, customerId, channel, externalId })
      .onConflictDoNothing({
        target: [
          representativeCustomerIdentity.userId,
          representativeCustomerIdentity.channel,
          representativeCustomerIdentity.externalId,
        ],
      })
      .returning({ id: representativeCustomerIdentity.id });
    if (made.length === 0) throw identityTaken();
    return customerId;
  });
  return readCustomer(context, userId, id);
}

/** Holds the owner's Customer row against a concurrent delete or merge, or says it isn't theirs. */
async function lockCustomer(tx: Transaction, userId: string, id: string) {
  const [row] = await tx
    .select({ id: representativeCustomer.id })
    .from(representativeCustomer)
    .where(and(eq(representativeCustomer.id, id), eq(representativeCustomer.userId, userId)))
    .for("update");
  if (!row || (await isMergedAway(tx, id))) throw customerNotFound();
}

/** Names a Customer; an empty name clears it. */
export async function renameCustomer(context: Context, userId: string, id: string, name: string) {
  await context.db.transaction(async (tx) => {
    await lockCustomer(tx, userId, id);
    await setOwnerValue(tx, context.clock(), userId, id, "name", name);
  });
  return readCustomer(context, userId, id);
}

/** Sets or, with an empty value, clears one value of a Customer's profile, as the owner's. */
export async function setProfileValue(
  context: Context,
  userId: string,
  { id, field, value }: { id: string; field: string; value: string },
) {
  await context.db.transaction(async (tx) => {
    await lockCustomer(tx, userId, id);
    await setOwnerValue(tx, context.clock(), userId, id, field, value);
  });
  return readCustomer(context, userId, id);
}

/** Gives a Customer another identity of the owner's. */
export async function addIdentity(
  context: Context,
  userId: string,
  { id, channel, externalId }: { id: string; channel: string; externalId: string },
) {
  await context.db.transaction(async (tx) => {
    await lockCustomer(tx, userId, id);
    const made = await tx
      .insert(representativeCustomerIdentity)
      .values({ id: uuidv7(), userId, customerId: id, channel, externalId })
      .onConflictDoNothing({
        target: [
          representativeCustomerIdentity.userId,
          representativeCustomerIdentity.channel,
          representativeCustomerIdentity.externalId,
        ],
      })
      .returning({ id: representativeCustomerIdentity.id });
    if (made.length === 0) throw identityTaken();
  });
  return readCustomer(context, userId, id);
}

/**
 * Corrects one identity of a Customer of the owner's. A new address starts unverified: what was
 * proved was proved by the old one, and a code or link sent for the old one can't prove the new. An
 * open thread last heard at the old address now goes to the new one, and so does what waits there, so
 * no Turn or word of the owner's treats it as another sender's. What came before stays as it was said.
 */
export async function updateIdentity(
  context: Context & Pick<FeatureContext<"pubsub">, "logger" | "pubsub">,
  userId: string,
  {
    id,
    identityId,
    channel,
    externalId,
  }: { id: string; identityId: string; channel: string; externalId: string },
) {
  const moved = await context.db.transaction(async (tx) => {
    await lockCustomer(tx, userId, id);
    const { channel: oldChannel, externalId: oldExternalId } = representativeCustomerIdentity;
    const sameAddress = sql`${oldChannel} = ${channel} and ${oldExternalId} = ${externalId}`;
    const [held] = await tx
      .select({
        same: sql<boolean>`${sameAddress}`,
        channel: oldChannel,
        externalId: oldExternalId,
      })
      .from(representativeCustomerIdentity)
      .where(
        and(
          eq(representativeCustomerIdentity.id, identityId),
          eq(representativeCustomerIdentity.customerId, id),
          eq(representativeCustomerIdentity.userId, userId),
        ),
      )
      .for("update");
    if (held && !held.same) await voidProofs(tx, identityId);
    try {
      const updated = await tx
        .update(representativeCustomerIdentity)
        .set({
          channel,
          externalId,
          verifiedContactAt: sql`case when ${sameAddress} then ${representativeCustomerIdentity.verifiedContactAt} end`,
          lapsedAt: sql`case when ${sameAddress} then ${representativeCustomerIdentity.lapsedAt} end`,
          provenUntil: sql`case when ${sameAddress} then ${representativeCustomerIdentity.provenUntil} end`,
          // Another address is another person's to say: their STOP was to the old one.
          optedOutAt: sql`case when ${sameAddress} then ${representativeCustomerIdentity.optedOutAt} end`,
          optOutSource: sql`case when ${sameAddress} then ${representativeCustomerIdentity.optOutSource} end`,
        })
        .where(
          and(
            eq(representativeCustomerIdentity.id, identityId),
            eq(representativeCustomerIdentity.customerId, id),
            eq(representativeCustomerIdentity.userId, userId),
          ),
        )
        .returning({ id: representativeCustomerIdentity.id });
      if (updated.length === 0) throw customerNotFound();
    } catch (error) {
      if (isUniqueViolation(error, identityAddress)) throw identityTaken();
      throw error;
    }
    if (held && !held.same) {
      // What another Customer's thread holds at this address follows the identity, so a delete of
      // this Customer finds it, and whoever is given the old address later doesn't. Their own
      // threads' stay as they were said and sent.
      const othersThreads = tx
        .select({ id: representativeThread.id })
        .from(representativeThread)
        .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
        .where(and(ne(representativeThread.customerId, id), eq(representative.userId, userId)));
      // A thread's row before the rows under it, the order a delete takes them in.
      await tx
        .update(representativeThread)
        .set({ lastChannel: channel, lastExternalId: externalId, channelAccountId: null })
        .where(
          and(
            or(
              and(
                eq(representativeThread.customerId, id),
                ne(representativeThread.state, "closed"),
              ),
              inArray(representativeThread.id, othersThreads),
            ),
            eq(representativeThread.lastChannel, held.channel),
            eq(representativeThread.lastExternalId, held.externalId),
          ),
        );
      const message = representativeThreadMessage;
      await tx
        .update(message)
        .set({ channel, externalId })
        .where(
          and(
            eq(message.channel, held.channel),
            eq(message.externalId, held.externalId),
            sql`exists (select 1 from ${representativeThread} where ${representativeThread.id} = ${message.threadId} and ${representativeThread.customerId} = ${id} and ${representativeThread.state} <> 'closed' and ${message.position} >= ${representativeThread.waitingFrom})`,
          ),
        );
      await tx
        .update(message)
        .set({ channel, externalId })
        .where(
          and(
            eq(message.channel, held.channel),
            eq(message.externalId, held.externalId),
            inArray(message.threadId, othersThreads),
          ),
        );
      const decision = representativeOutboundDecision;
      await tx
        .update(decision)
        .set({ channel, externalId })
        .where(
          and(
            eq(decision.channel, held.channel),
            eq(decision.externalId, held.externalId),
            inArray(decision.threadId, othersThreads),
          ),
        );
      // By its Customer, as a hand-off outlives its thread. Its result goes to the new address too.
      const handOff = representativeHandOff;
      await tx
        .update(handOff)
        .set({ channel, externalId })
        .where(
          and(
            eq(handOff.channel, held.channel),
            eq(handOff.externalId, held.externalId),
            ne(handOff.customerId, id),
            inArray(
              handOff.customerId,
              tx
                .select({ id: representativeCustomer.id })
                .from(representativeCustomer)
                .where(eq(representativeCustomer.userId, userId)),
            ),
          ),
        );
      // The inbound limit counts a number, so a Call's follows its identity's to a new one.
      if (channel === smsChannel) {
        const call = representativeCall;
        const theirCalls = eq(call.identityId, identityId);
        // Each thread's lock before its Calls, the order a Call's request and end take them in.
        await tx
          .select({ id: representativeThread.id })
          .from(representativeThread)
          .where(
            inArray(
              representativeThread.id,
              tx.select({ id: call.threadId }).from(call).where(theirCalls),
            ),
          )
          .orderBy(representativeThread.id)
          .for("update");
        await tx
          .update(message)
          .set({ externalId })
          .where(
            inArray(message.id, tx.select({ id: call.messageId }).from(call).where(theirCalls)),
          );
        await tx.update(call).set({ externalId }).where(theirCalls);
      }
      // What waits for the owner goes where this Customer now is, as what the thread sends next does.
      await tx
        .update(decision)
        .set({ channel, externalId })
        .where(
          and(
            eq(decision.channel, held.channel),
            eq(decision.externalId, held.externalId),
            sql`exists (select 1 from ${representativeHeldMessage} join ${representativeThread} on ${representativeThread.id} = ${representativeHeldMessage.threadId} where ${representativeHeldMessage.decisionId} = ${decision.id} and ${representativeHeldMessage.resolution} is null and ${representativeThread.customerId} = ${id})`,
          ),
        );
    }
    return held && !held.same ? held : null;
  });
  // The session at either address reads a different thread now.
  if (moved) {
    hintVisitor(context, moved);
    hintVisitor(context, { channel, externalId });
  }
  return readCustomer(context, userId, id);
}

/**
 * Blocks or unblocks a Customer. Blocking aborts their threads' Turns, as a takeover does, so no more
 * Model calls run and no Assignment opens: the job's fence refuses what those Turns try next. A
 * message already kept stays kept; the next one is answered again once unblocked.
 */
export async function setBlocked(
  context: Context & Pick<FeatureContext, "jobs">,
  userId: string,
  id: string,
  blocked: boolean,
  now: Date,
) {
  await context.db.transaction(async (tx) => {
    await lockCustomer(tx, userId, id);
    await tx
      .update(representativeCustomer)
      .set({
        blockedAt: blocked
          ? sql`coalesce(${representativeCustomer.blockedAt}, ${now.toISOString()}::timestamp)`
          : null,
      })
      .where(eq(representativeCustomer.id, id));
    // What waited gets no Turn, then or after an unblock: only the next message is answered.
    if (blocked) {
      const threads = await tx
        .select({ turnId: representativeThread.turnId })
        .from(representativeThread)
        .where(eq(representativeThread.customerId, id))
        .for("update");
      for (const { turnId } of threads) {
        if (turnId) await context.jobs.cancelIn(tx, turnId);
      }
      await tx
        .update(representativeThread)
        .set({ turnId: null, waitingFrom: null, waitingSince: null })
        .where(eq(representativeThread.customerId, id));
    }
  });
  return readCustomer(context, userId, id);
}

/** Clears the opt-out of one identity of a Customer of the owner's, as that Customer's START would. */
export async function clearOptOut(
  context: Context,
  userId: string,
  { id, identityId }: { id: string; identityId: string },
) {
  await context.db.transaction(async (tx) => {
    await lockCustomer(tx, userId, id);
    const identity = representativeCustomerIdentity;
    const found = await tx
      .update(identity)
      .set({ optedOutAt: null, optOutSource: null })
      .where(
        and(eq(identity.id, identityId), eq(identity.customerId, id), eq(identity.userId, userId)),
      )
      .returning({ id: identity.id });
    if (found.length === 0) throw customerNotFound();
  });
  return readCustomer(context, userId, id);
}

type ThreadRow = {
  id: string;
  customerId: string;
  blockedAt: Date | null;
  representativeId: string;
  state: ThreadState;
  lastChannel: string;
  lastExternalId: string;
  messageCount: number;
  turnId: string | null;
  waitingFrom: number | null;
  limitNotedAt: Date | null;
  leftForOwnerAt: Date | null;
  updatedAt: Date;
  lastAuthor: ThreadAuthor | null;
  lastReplyKind: StoredReplyKind | null;
  botWorking: boolean;
  heldWaiting: boolean;
};

/** Whether an Assignment handed off from the thread is still open. */
const botWorkingQuery = sql`exists (select 1 from ${representativeHandOff} inner join ${botAssignment} on ${botAssignment.id} = ${representativeHandOff.assignmentId} where ${representativeHandOff.threadId} = ${representativeThread.id} and ${botAssignment.status} not in (${sql.join(
  endedAssignmentStatuses.map((status) => sql`${status}`),
  sql`, `,
)}))`;

const threadColumns = {
  id: representativeThread.id,
  customerId: representativeThread.customerId,
  blockedAt: representativeCustomer.blockedAt,
  representativeId: representativeThread.representativeId,
  state: representativeThread.state,
  lastChannel: representativeThread.lastChannel,
  lastExternalId: representativeThread.lastExternalId,
  messageCount: representativeThread.messageCount,
  turnId: representativeThread.turnId,
  waitingFrom: representativeThread.waitingFrom,
  limitNotedAt: representativeThread.limitNotedAt,
  leftForOwnerAt: representativeThread.leftForOwnerAt,
  updatedAt: representativeThread.updatedAt,
  lastAuthor: sql<ThreadAuthor | null>`(${lastMessageQuery(representativeThreadMessage.author)})`,
  lastReplyKind: sql<StoredReplyKind | null>`(${lastMessageQuery(representativeThreadMessage.replyKind)})`,
  botWorking: sql<boolean>`${botWorkingQuery}`,
  heldWaiting: sql<boolean>`${heldWaitingQuery}`,
};

function summary(row: ThreadRow, customerName: string | null): ThreadSummary {
  const holder: ThreadHolder = row.state;
  return {
    id: row.id,
    customer: {
      id: row.customerId,
      name: customerName,
      blocked: row.blockedAt !== null,
    },
    lastHeard: { channel: row.lastChannel, externalId: row.lastExternalId },
    holder,
    // A thread a Call opened has no message until the Call ends: nobody owes anyone a word yet.
    waitingOn:
      row.messageCount === 0
        ? null
        : waitingOn(
            row.state,
            row.lastAuthor,
            row.blockedAt !== null,
            row.turnId !== null || row.waitingFrom !== null,
            row.botWorking,
            row.lastReplyKind === codeHandOffKind,
            row.limitNotedAt !== null && row.waitingFrom !== null,
            row.leftForOwnerAt !== null,
            row.heldWaiting,
          ),
    messageCount: row.messageCount,
    updatedAt: row.updatedAt,
  };
}

/** The owner's threads, joined to their Customer and Representative (the owner's check). */
function threadRows(db: Db, userId: string) {
  return db
    .select(threadColumns)
    .from(representativeThread)
    .innerJoin(
      representativeCustomer,
      and(
        eq(representativeCustomer.id, representativeThread.customerId),
        eq(representativeCustomer.userId, userId),
      ),
    )
    .innerJoin(
      representative,
      and(
        eq(representative.id, representativeThread.representativeId),
        eq(representative.userId, userId),
      ),
    );
}

/** A Representative's threads, the most recently active first. */
export async function listThreads(
  { db }: Context,
  userId: string,
  representativeId: string,
): Promise<ThreadSummary[]> {
  const [owned] = await db
    .select({ id: representative.id })
    .from(representative)
    .where(and(eq(representative.id, representativeId), eq(representative.userId, userId)));
  if (!owned) {
    throw rpcError("NOT_FOUND", "error.representativeNotFound", "Representative not found");
  }
  const rows = await threadRows(db, userId)
    .where(eq(representativeThread.representativeId, representativeId))
    .orderBy(desc(representativeThread.updatedAt), desc(representativeThread.id));
  const profiles = await combinedProfilesOf(db, userId, [
    ...new Set(rows.map((row) => row.customerId)),
  ]);
  return rows.map((row) => summary(row, nameIn(profiles.get(row.customerId))));
}

/** The most threads the inbox lists as running. */
const runningListLimit = 50;

/**
 * The threads the owner's Representatives hold, the most recently active first (ticket #1313): those
 * running without the owner. One they took over, and a closed one, are not.
 */
export async function listRunningThreads({ db }: Context, userId: string) {
  const rows = await threadRows(db, userId)
    .where(eq(representativeThread.state, "representative"))
    .orderBy(desc(representativeThread.updatedAt), desc(representativeThread.id))
    .limit(runningListLimit + 1);
  const listed = rows.slice(0, runningListLimit);
  const profiles = await combinedProfilesOf(db, userId, [
    ...new Set(listed.map((row) => row.customerId)),
  ]);
  return {
    running: listed.map((row) => ({
      ...summary(row, nameIn(profiles.get(row.customerId))),
      representativeId: row.representativeId,
    })),
    truncated: rows.length > runningListLimit,
  };
}

/** One thread of the owner's with its transcript, oldest first. */
export async function getThread(
  context: Context,
  userId: string,
  threadId: string,
): Promise<ThreadView> {
  const { db } = context;
  const [row] = await threadRows(db, userId).where(eq(representativeThread.id, threadId));
  if (!row) throw threadNotFound();
  const messages: ThreadMessageView[] = await db
    .select({
      id: representativeThreadMessage.id,
      author: representativeThreadMessage.author,
      text: representativeThreadMessage.text,
      channel: representativeThreadMessage.channel,
      externalId: representativeThreadMessage.externalId,
      verified: representativeThreadMessage.verified,
      replyKind: representativeThreadMessage.replyKind,
      sources: representativeThreadMessage.sources,
      createdAt: representativeThreadMessage.createdAt,
    })
    .from(representativeThreadMessage)
    .where(eq(representativeThreadMessage.threadId, threadId))
    .orderBy(asc(representativeThreadMessage.position))
    .then((rows) =>
      rows.map(({ replyKind, sources, ...message }) => ({
        ...message,
        reply:
          message.author === "representative" ? { kind: replyKind, sources: sources ?? [] } : null,
        call: null as CallEntryView | null,
      })),
    );
  const calls = await db
    .select({
      messageId: representativeCall.messageId,
      status: representativeCall.status,
      startedAt: representativeCall.startedAt,
      endedAt: representativeCall.endedAt,
      requests: representativeCall.requests,
    })
    .from(representativeCall)
    .where(eq(representativeCall.threadId, threadId))
    .orderBy(asc(representativeCall.startedAt));
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const call of calls) {
    const message = call.messageId === null ? undefined : byId.get(call.messageId);
    if (message) {
      const { messageId: _messageId, ...times } = call;
      // A lost Call's entry says it has no transcript and lists its requests, for a Turn to read;
      // none of that is anything the Representative said.
      const lines = call.status === "ended_no_transcript" ? [] : transcriptLines(message.text);
      message.call = { ...times, lines };
    }
  }
  const live = calls.filter((call) => call.status === "in_progress").at(-1);
  const { identities, name } = await readCustomer(context, userId, row.customerId);
  const held = await db
    .select({
      id: representativeHeldMessage.id,
      text: representativeHeldMessage.text,
      rule: representativeOutboundDecision.rule,
      channel: representativeOutboundDecision.channel,
      externalId: representativeOutboundDecision.externalId,
      createdAt: representativeHeldMessage.createdAt,
    })
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
      ),
    )
    .orderBy(asc(representativeHeldMessage.id));
  return {
    ...summary(row, name),
    representativeId: row.representativeId,
    identities,
    messages,
    held,
    liveCall: live ? { startedAt: live.startedAt, requests: live.requests } : null,
  };
}
