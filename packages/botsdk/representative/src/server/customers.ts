import { and, asc, desc, eq, sql } from "drizzle-orm";

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
 * Stores a Customer's message on its thread, and reads what the Turn will: `null` when the
 * Representative's row has gone. It holds that row, so the owner's delete, which removes
 * Representatives before Customers, can't leave a Customer behind.
 */
export async function receiveMessage(
  tx: Transaction,
  {
    userId,
    representativeId,
    heard,
    text,
  }: { userId: string; representativeId: string; heard: Heard; text: string },
) {
  const [held] = await tx
    .select({ id: representative.id })
    .from(representative)
    .where(eq(representative.id, representativeId))
    .for("key share");
  if (!held) return null;
  const customerId = await findOrMakeCustomer(tx, userId, heard);
  const [thread] = await tx
    .insert(representativeThread)
    .values({
      id: uuidv7(),
      customerId,
      representativeId,
      lastChannel: heard.channel,
      lastExternalId: heard.externalId,
    })
    .onConflictDoUpdate({
      target: [representativeThread.customerId, representativeThread.representativeId],
      targetWhere: sql`state <> 'closed'`,
      set: {
        lastChannel: heard.channel,
        lastExternalId: heard.externalId,
        updatedAt: new Date(),
      },
    })
    .returning({ id: representativeThread.id });
  const threadId = thread!.id;
  await tx
    .insert(representativeThreadMessage)
    .values({ id: uuidv7(), threadId, author: "customer", text, ...heard });
  const newest: ThreadEntry[] = await tx
    .select({
      author: representativeThreadMessage.author,
      text: representativeThreadMessage.text,
    })
    .from(representativeThreadMessage)
    .where(eq(representativeThreadMessage.threadId, threadId))
    .orderBy(desc(representativeThreadMessage.createdAt), desc(representativeThreadMessage.id))
    .limit(threadPromptLimit);
  return { customerId, threadId, entries: newest.reverse() };
}

/** Stores a reply as sent on the Channel the Customer was last heard from, as it is right now. */
export async function storeReply(tx: Transaction, threadId: string, text: string) {
  const [thread] = await tx
    .select({
      channel: representativeThread.lastChannel,
      externalId: representativeThread.lastExternalId,
    })
    .from(representativeThread)
    .where(eq(representativeThread.id, threadId))
    .for("key share");
  if (!thread) return { error: "This Customer's thread is gone, so nothing was sent." };
  await tx
    .insert(representativeThreadMessage)
    .values({ id: uuidv7(), threadId, author: "representative", text, ...thread });
  await tx
    .update(representativeThread)
    .set({ updatedAt: new Date() })
    .where(eq(representativeThread.id, threadId));
  return { sent: true };
}

/** Each of `userId`'s Customers, with its identities and its threads' messages. */
export async function exportCustomers(tx: Transaction, userId: string) {
  const customers = await tx
    .select()
    .from(representativeCustomer)
    .where(eq(representativeCustomer.userId, userId))
    .orderBy(asc(representativeCustomer.createdAt), asc(representativeCustomer.id));
  const exported = [];
  for (const { id, createdAt } of customers) {
    const identities = await tx
      .select({
        channel: representativeCustomerIdentity.channel,
        externalId: representativeCustomerIdentity.externalId,
        createdAt: representativeCustomerIdentity.createdAt,
      })
      .from(representativeCustomerIdentity)
      .where(eq(representativeCustomerIdentity.customerId, id))
      .orderBy(
        asc(representativeCustomerIdentity.createdAt),
        asc(representativeCustomerIdentity.id),
      );
    const threads = await tx
      .select()
      .from(representativeThread)
      .where(eq(representativeThread.customerId, id))
      .orderBy(asc(representativeThread.createdAt), asc(representativeThread.id));
    const withMessages = [];
    for (const thread of threads) {
      const messages = await tx
        .select({
          author: representativeThreadMessage.author,
          text: representativeThreadMessage.text,
          channel: representativeThreadMessage.channel,
          externalId: representativeThreadMessage.externalId,
          createdAt: representativeThreadMessage.createdAt,
        })
        .from(representativeThreadMessage)
        .where(eq(representativeThreadMessage.threadId, thread.id))
        .orderBy(asc(representativeThreadMessage.createdAt), asc(representativeThreadMessage.id));
      withMessages.push({
        id: thread.id,
        representativeId: thread.representativeId,
        state: thread.state,
        lastChannel: thread.lastChannel,
        lastExternalId: thread.lastExternalId,
        createdAt: thread.createdAt,
        messages,
      });
    }
    exported.push({ id, createdAt, identities, threads: withMessages });
  }
  return exported;
}

/** Removes `userId`'s Customers; their identities and threads go with them (foreign keys cascade). */
export async function deleteCustomers(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(representativeCustomer).where(eq(representativeCustomer.userId, userId));
}
