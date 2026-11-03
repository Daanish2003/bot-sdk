import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import { isUniqueViolation } from "@botsdk/bot/lib/unique-violation";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { rpcError } from "@botsdk/bot/rpc-error";
import type { Transaction } from "@botsdk/bot/plugin";
import type {
  CustomerView,
  ThreadHolder,
  ThreadMessageView,
  ThreadSummary,
  ThreadView,
  ThreadWaitingOn,
} from "../shared/contract";
import {
  representative,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeThread,
  representativeThreadMessage,
  type ThreadAuthor,
  type ThreadState,
} from "./db/schema";
import { isVerified } from "./verification";

/*
 * What the owner sees and does with their Customers and threads (ticket #1251). Every read and write
 * starts from the owner's id, and a Customer, identity, thread or Representative of someone else's
 * is "not found", the same as one that doesn't exist. No foreign key ties an identity's or a
 * thread's owner to its Customer's, so each write path here checks it.
 */

type Context = Pick<FeatureContext, "db" | "clock">;
type Db = Context["db"] | Transaction;

const identityAddress = "representative_customer_identity_address";

const customerNotFound = () =>
  rpcError("NOT_FOUND", "error.customerNotFound", "Customer not found");
const threadNotFound = () => rpcError("NOT_FOUND", "error.threadNotFound", "Thread not found");
const identityTaken = () =>
  rpcError(
    "CONFLICT",
    "error.customerIdentityTaken",
    "You already have a Customer with that identity",
  );

/**
 * Who a thread is waiting on, from who holds it, who spoke last and whether a message waits for a
 * next Turn, which a reply can come after. A blocked Customer's message waits on no one: nothing
 * answers it.
 */
export function waitingOn(
  state: ThreadState,
  lastAuthor: ThreadAuthor | null,
  blocked: boolean,
  waitingForTurn: boolean,
): ThreadWaitingOn {
  if (state === "closed" || blocked) return null;
  if (state === "owner") return "owner";
  return lastAuthor === "representative" && !waitingForTurn ? "customer" : "representative";
}

/** `userId`'s Customers named by `ids` (all of them when omitted), oldest first, with their identities. */
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
  return customers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    blocked: customer.blockedAt !== null,
    createdAt: customer.createdAt,
    identities: identities
      .filter((identity) => identity.customerId === customer.id)
      .map(({ id, channel, externalId, verifiedContactAt }) => ({
        id,
        channel,
        externalId,
        verified: isVerified({ verifiedContactAt }, now),
      })),
  }));
}

async function readCustomer(context: Context, userId: string, id: string) {
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
    await tx.insert(representativeCustomer).values({ id: customerId, userId, name });
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

/** Holds the owner's Customer row against a concurrent delete, or says it isn't theirs. */
async function lockCustomer(tx: Transaction, userId: string, id: string) {
  const [row] = await tx
    .select({ id: representativeCustomer.id })
    .from(representativeCustomer)
    .where(and(eq(representativeCustomer.id, id), eq(representativeCustomer.userId, userId)))
    .for("update");
  if (!row) throw customerNotFound();
}

/** Names a Customer; an empty name clears it. */
export async function renameCustomer(context: Context, userId: string, id: string, name: string) {
  const [updated] = await context.db
    .update(representativeCustomer)
    .set({ name: name === "" ? null : name })
    .where(and(eq(representativeCustomer.id, id), eq(representativeCustomer.userId, userId)))
    .returning({ id: representativeCustomer.id });
  if (!updated) throw customerNotFound();
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
 * proved was proved by the old one.
 */
export async function updateIdentity(
  context: Context,
  userId: string,
  {
    id,
    identityId,
    channel,
    externalId,
  }: { id: string; identityId: string; channel: string; externalId: string },
) {
  await context.db.transaction(async (tx) => {
    await lockCustomer(tx, userId, id);
    const { channel: oldChannel, externalId: oldExternalId } = representativeCustomerIdentity;
    const sameAddress = sql`${oldChannel} = ${channel} and ${oldExternalId} = ${externalId}`;
    try {
      const updated = await tx
        .update(representativeCustomerIdentity)
        .set({
          channel,
          externalId,
          verifiedContactAt: sql`case when ${sameAddress} then ${representativeCustomerIdentity.verifiedContactAt} end`,
          lapsedAt: sql`case when ${sameAddress} then ${representativeCustomerIdentity.lapsedAt} end`,
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
  });
  return readCustomer(context, userId, id);
}

/**
 * Blocks or unblocks a Customer. A message already kept stays kept; the next one is answered again
 * once unblocked.
 */
export async function setBlocked(
  context: Context,
  userId: string,
  id: string,
  blocked: boolean,
  now: Date,
) {
  await context.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(representativeCustomer)
      .set({
        blockedAt: blocked ? sql`coalesce(${representativeCustomer.blockedAt}, ${now})` : null,
      })
      .where(and(eq(representativeCustomer.id, id), eq(representativeCustomer.userId, userId)))
      .returning({ id: representativeCustomer.id });
    if (!updated) throw customerNotFound();
    // What waited gets no Turn, then or after an unblock: only the next message is answered.
    if (blocked) {
      await tx
        .update(representativeThread)
        .set({ waitingFrom: null, waitingSince: null })
        .where(eq(representativeThread.customerId, id));
    }
  });
  return readCustomer(context, userId, id);
}

type ThreadRow = {
  id: string;
  customerId: string;
  customerName: string | null;
  blockedAt: Date | null;
  representativeId: string;
  state: ThreadState;
  lastChannel: string;
  lastExternalId: string;
  messageCount: number;
  waitingFrom: number | null;
  updatedAt: Date;
  lastAuthor: ThreadAuthor | null;
};

const threadColumns = {
  id: representativeThread.id,
  customerId: representativeThread.customerId,
  customerName: representativeCustomer.name,
  blockedAt: representativeCustomer.blockedAt,
  representativeId: representativeThread.representativeId,
  state: representativeThread.state,
  lastChannel: representativeThread.lastChannel,
  lastExternalId: representativeThread.lastExternalId,
  messageCount: representativeThread.messageCount,
  waitingFrom: representativeThread.waitingFrom,
  updatedAt: representativeThread.updatedAt,
  lastAuthor: representativeThreadMessage.author,
};

function summary(row: ThreadRow): ThreadSummary {
  const holder: ThreadHolder = row.state;
  return {
    id: row.id,
    customer: {
      id: row.customerId,
      name: row.customerName,
      blocked: row.blockedAt !== null,
    },
    lastHeard: { channel: row.lastChannel, externalId: row.lastExternalId },
    holder,
    waitingOn: waitingOn(
      row.state,
      row.lastAuthor,
      row.blockedAt !== null,
      row.waitingFrom !== null,
    ),
    messageCount: row.messageCount,
    updatedAt: row.updatedAt,
  };
}

/** The owner's threads, joined to their Customer (the owner's check) and last message. */
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
    )
    .leftJoin(
      representativeThreadMessage,
      and(
        eq(representativeThreadMessage.threadId, representativeThread.id),
        eq(representativeThreadMessage.position, representativeThread.messageCount),
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
  return rows.map(summary);
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
      createdAt: representativeThreadMessage.createdAt,
    })
    .from(representativeThreadMessage)
    .where(eq(representativeThreadMessage.threadId, threadId))
    .orderBy(asc(representativeThreadMessage.position));
  const { identities } = await readCustomer(context, userId, row.customerId);
  return {
    ...summary(row),
    representativeId: row.representativeId,
    identities,
    messages,
  };
}
