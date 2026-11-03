import { and, asc, desc, eq, isNotNull, lte, notExists, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import {
  representative,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeThread,
  representativeThreadMessage,
  type ThreadAuthor,
} from "./db/schema";

/*
 * Customers and their threads (ticket #1249). A message finds or makes its Customer by identity
 * under the owner, opens the one thread for that Customer and Representative, and is stored there.
 * Code sets the Customer's id from that row: no tool takes one, and neither does the job's payload.
 */

/** The most thread messages a Turn reads, newest kept, so a long thread can't grow without end. */
export const threadPromptLimit = 100;

/** The most characters of a thread a Turn reads, so a few huge messages can't fail every later Turn. */
export const threadPromptChars = 200_000;

/** The longest one thread message may be, either way. */
export const maxThreadMessageLength = 60_000;

/** Where a Customer's message came from. */
export type Heard = { channel: string; externalId: string };

/** A thread message as a Turn reads it. */
export type ThreadEntry = { author: ThreadAuthor; text: string };

/** The Customer behind an identity of `userId`'s, made along with the identity on its first message. */
async function findOrMakeCustomer(tx: Transaction, userId: string, heard: Heard) {
  const existing = () =>
    tx
      .select({ customerId: representativeCustomerIdentity.customerId })
      .from(representativeCustomerIdentity)
      .where(
        and(
          eq(representativeCustomerIdentity.userId, userId),
          eq(representativeCustomerIdentity.channel, heard.channel),
          eq(representativeCustomerIdentity.externalId, heard.externalId),
        ),
      );
  const [found] = await existing();
  if (found) return found.customerId;
  const customerId = uuidv7();
  await tx.insert(representativeCustomer).values({ id: customerId, userId });
  const made = await tx
    .insert(representativeCustomerIdentity)
    .values({ id: uuidv7(), userId, customerId, ...heard })
    .onConflictDoNothing()
    .returning({ id: representativeCustomerIdentity.id });
  if (made.length > 0) return customerId;
  // Another first message of this identity won, and has committed: its Customer is the one.
  await tx.delete(representativeCustomer).where(eq(representativeCustomer.id, customerId));
  const [winner] = await existing();
  return winner!.customerId;
}

/**
 * Stores a Customer's message on its thread, whether or not a Turn can run: `null` only when the
 * Representative doesn't exist. It holds that row, so the owner's delete, which removes
 * Representatives before Customers, can't leave a Customer behind. What it returns goes in a
 * Checkpoint, which user delete doesn't reach: ids and a place in the thread, not the thread's text.
 * A blocked Customer's message is stored all the same, for the owner (ticket #1251); `blocked` tells the
 * Turn to run no model and send nothing.
 */
export async function receiveMessage(
  tx: Transaction,
  {
    representativeId,
    heard,
    text,
    now,
  }: { representativeId: string; heard: Heard; text: string; now: Date },
) {
  const [owner] = await tx
    .select({ userId: representative.userId })
    .from(representative)
    .where(eq(representative.id, representativeId))
    .for("key share");
  if (!owner) return null;
  const customerId = await findOrMakeCustomer(tx, owner.userId, heard);
  const [customer] = await tx
    .select({ blockedAt: representativeCustomer.blockedAt })
    .from(representativeCustomer)
    .where(eq(representativeCustomer.id, customerId));
  const [thread] = await tx
    .insert(representativeThread)
    .values({
      id: uuidv7(),
      customerId,
      representativeId,
      lastChannel: heard.channel,
      lastExternalId: heard.externalId,
      messageCount: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [representativeThread.customerId, representativeThread.representativeId],
      targetWhere: sql`state <> 'closed'`,
      set: {
        lastChannel: heard.channel,
        lastExternalId: heard.externalId,
        messageCount: sql`${representativeThread.messageCount} + 1`,
        updatedAt: sql`greatest(${representativeThread.updatedAt}, ${now.toISOString()}::timestamp)`,
      },
    })
    .returning({ id: representativeThread.id, position: representativeThread.messageCount });
  const { id: threadId, position } = thread!;
  await tx
    .insert(representativeThreadMessage)
    .values({ id: uuidv7(), threadId, position, author: "customer", text, ...heard });
  // Position 1 is a thread's first message: it has just been opened.
  return {
    customerId,
    threadId,
    position,
    opened: position === 1,
    blocked: customer!.blockedAt !== null,
  };
}

/**
 * What a Turn reads of its thread: oldest first, up to and including `upTo`, so a replay reads what
 * the first attempt read, and within both limits. Empty once the thread has gone.
 */
export async function readThread(
  db: FeatureContext["db"],
  threadId: string,
  upTo: number,
): Promise<ThreadEntry[]> {
  const newest = await db
    .select({
      author: representativeThreadMessage.author,
      text: representativeThreadMessage.text,
    })
    .from(representativeThreadMessage)
    .where(
      and(
        eq(representativeThreadMessage.threadId, threadId),
        lte(representativeThreadMessage.position, upTo),
      ),
    )
    .orderBy(desc(representativeThreadMessage.position))
    .limit(threadPromptLimit);
  const kept: ThreadEntry[] = [];
  let chars = 0;
  for (const entry of newest) {
    chars += entry.text.length;
    if (chars > threadPromptChars) break;
    kept.push(entry);
  }
  return kept.reverse();
}

/**
 * Stores a reply as sent on the Channel the Customer was last heard from, if the Representative
 * still holds the thread. The update waits for a message being received on the thread, so it reads
 * where that message came from.
 */
export async function storeReply(tx: Transaction, threadId: string, text: string, now: Date) {
  const [thread] = await tx
    .update(representativeThread)
    .set({
      messageCount: sql`${representativeThread.messageCount} + 1`,
      updatedAt: sql`greatest(${representativeThread.updatedAt}, ${now.toISOString()}::timestamp)`,
    })
    .where(
      and(
        eq(representativeThread.id, threadId),
        eq(representativeThread.state, "representative"),
        // A Turn that began before the owner blocked this Customer sends nothing more.
        notExists(
          tx
            .select({ one: sql`1` })
            .from(representativeCustomer)
            .where(
              and(
                eq(representativeCustomer.id, representativeThread.customerId),
                isNotNull(representativeCustomer.blockedAt),
              ),
            ),
        ),
      ),
    )
    .returning({
      position: representativeThread.messageCount,
      channel: representativeThread.lastChannel,
      externalId: representativeThread.lastExternalId,
    });
  if (!thread)
    return {
      error:
        "This thread is gone or no longer yours to answer (it may be held by the owner, or its Customer blocked), so nothing was sent.",
    };
  await tx
    .insert(representativeThreadMessage)
    .values({ id: uuidv7(), threadId, author: "representative", text, ...thread });
  return { sent: true };
}

/** `rows` by the key `keyOf` gives, each group in the order given. */
function grouped<T>(rows: T[], keyOf: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** Each of `userId`'s Customers, with its identities and its threads' messages. */
export async function exportCustomers(tx: Transaction, userId: string) {
  const customers = await tx
    .select({ id: representativeCustomer.id, createdAt: representativeCustomer.createdAt })
    .from(representativeCustomer)
    .where(eq(representativeCustomer.userId, userId))
    .orderBy(asc(representativeCustomer.createdAt), asc(representativeCustomer.id));
  const identities = grouped(
    await tx
      .select({
        customerId: representativeCustomerIdentity.customerId,
        channel: representativeCustomerIdentity.channel,
        externalId: representativeCustomerIdentity.externalId,
        createdAt: representativeCustomerIdentity.createdAt,
      })
      .from(representativeCustomerIdentity)
      .where(eq(representativeCustomerIdentity.userId, userId))
      .orderBy(
        asc(representativeCustomerIdentity.createdAt),
        asc(representativeCustomerIdentity.id),
      ),
    (row) => row.customerId,
  );
  const threads = grouped(
    await tx
      .select({
        id: representativeThread.id,
        customerId: representativeThread.customerId,
        representativeId: representativeThread.representativeId,
        state: representativeThread.state,
        lastChannel: representativeThread.lastChannel,
        lastExternalId: representativeThread.lastExternalId,
        createdAt: representativeThread.createdAt,
      })
      .from(representativeThread)
      .innerJoin(
        representativeCustomer,
        eq(representativeCustomer.id, representativeThread.customerId),
      )
      .where(eq(representativeCustomer.userId, userId))
      .orderBy(asc(representativeThread.createdAt), asc(representativeThread.id)),
    (row) => row.customerId,
  );
  const messages = grouped(
    await tx
      .select({
        threadId: representativeThreadMessage.threadId,
        author: representativeThreadMessage.author,
        text: representativeThreadMessage.text,
        channel: representativeThreadMessage.channel,
        externalId: representativeThreadMessage.externalId,
        createdAt: representativeThreadMessage.createdAt,
      })
      .from(representativeThreadMessage)
      .innerJoin(
        representativeThread,
        eq(representativeThread.id, representativeThreadMessage.threadId),
      )
      .innerJoin(
        representativeCustomer,
        eq(representativeCustomer.id, representativeThread.customerId),
      )
      .where(eq(representativeCustomer.userId, userId))
      .orderBy(
        asc(representativeThreadMessage.threadId),
        asc(representativeThreadMessage.position),
      ),
    (row) => row.threadId,
  );
  return customers.map(({ id, createdAt }) => ({
    id,
    createdAt,
    identities: (identities.get(id) ?? []).map((row) => ({
      channel: row.channel,
      externalId: row.externalId,
      createdAt: row.createdAt,
    })),
    threads: (threads.get(id) ?? []).map((thread) => ({
      id: thread.id,
      representativeId: thread.representativeId,
      state: thread.state,
      lastChannel: thread.lastChannel,
      lastExternalId: thread.lastExternalId,
      createdAt: thread.createdAt,
      messages: (messages.get(thread.id) ?? []).map((message) => ({
        author: message.author,
        text: message.text,
        channel: message.channel,
        externalId: message.externalId,
        createdAt: message.createdAt,
      })),
    })),
  }));
}

/** Removes `userId`'s Customers; their identities and threads go with them (foreign keys cascade). */
export async function deleteCustomers(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(representativeCustomer).where(eq(representativeCustomer.userId, userId));
}
