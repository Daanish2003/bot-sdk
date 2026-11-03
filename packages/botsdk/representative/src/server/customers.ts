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
import { holdCustomers } from "./customer-merge";
import { catchCode, customerProofLeadsTo, mayHoldCode } from "./customer-proof";
import { type ChannelProof, judgeSender } from "./verification";
import type { ReplyKind, ReplySource } from "../shared/replies";

/*
 * Customers and their threads (ticket #1249). A message finds or makes its Customer by identity
 * under the owner, opens the one thread for that Customer and Representative, and is stored there.
 * Code sets the Customer's id from that row: no tool takes one, and neither does the job's payload.
 */

/** The most thread messages a Turn reads, newest kept, so a long thread can't grow without end. */
export const threadPromptLimit = 100;

/** The most characters of a thread a Turn reads, so a few huge messages can't fail every later Turn. */
export const threadPromptChars = 200_000;

/** Where a Customer's message came from. */
export type Heard = { channel: string; externalId: string };

/** A thread message as a Turn reads it; `earlier` when it isn't part of what this Turn answers. */
export type ThreadEntry = {
  author: ThreadAuthor;
  text: string;
  verified: boolean;
  earlier?: boolean;
  /** The Assignment behind a Bot's result that is this Turn's to tell. */
  assignmentId?: string;
};

/** An identity of `userId`'s with its Customer, made together on the identity's first message. */
async function findOrMakeIdentity(tx: Transaction, userId: string, heard: Heard) {
  const existing = () =>
    tx
      .select({
        identityId: representativeCustomerIdentity.id,
        customerId: representativeCustomerIdentity.customerId,
      })
      .from(representativeCustomerIdentity)
      .where(
        and(
          eq(representativeCustomerIdentity.userId, userId),
          eq(representativeCustomerIdentity.channel, heard.channel),
          eq(representativeCustomerIdentity.externalId, heard.externalId),
        ),
      );
  const [found] = await existing();
  if (found) return found;
  const customerId = uuidv7();
  await tx.insert(representativeCustomer).values({ id: customerId, userId });
  const made = await tx
    .insert(representativeCustomerIdentity)
    .values({ id: uuidv7(), userId, customerId, ...heard })
    .onConflictDoNothing()
    .returning({ id: representativeCustomerIdentity.id });
  if (made[0]) return { identityId: made[0].id, customerId };
  // Another first message of this identity won, and has committed: its Customer is the one.
  await tx.delete(representativeCustomer).where(eq(representativeCustomer.id, customerId));
  const [winner] = await existing();
  return winner!;
}

/** The Customer an identity is on now. */
async function customerOfIdentity(tx: Transaction, identityId: string) {
  const [identity] = await tx
    .select({ customerId: representativeCustomerIdentity.customerId })
    .from(representativeCustomerIdentity)
    .where(eq(representativeCustomerIdentity.id, identityId));
  return identity!.customerId;
}

/**
 * Finds or makes the sender's identity and holds its Customer until `tx` ends, so that no merge, undo
 * or edit can move that identity, and returns both. One that moved them as this waited is followed:
 * to the Customer a merge put them on, or, when the owner corrected this address away, to whoever
 * has it now, which may be someone new. The owner's edits take a Customer before its identity, so
 * this does too. A message that could pass a live code to another Customer holds both as a merge
 * does, since waiting for that later, with its identity held, could deadlock with this sender's next
 * message.
 */
async function holdSender(tx: Transaction, userId: string, heard: Heard, text: string, now: Date) {
  const merges = mayHoldCode(text);
  for (;;) {
    const { identityId, customerId } = await findOrMakeIdentity(tx, userId, heard);
    const leadsTo = merges ? await customerProofLeadsTo(tx, identityId, now) : undefined;
    if (leadsTo && leadsTo !== customerId) {
      await holdCustomers(tx, [customerId, leadsTo]);
    } else {
      await tx
        .select({ id: representativeCustomer.id })
        .from(representativeCustomer)
        .where(eq(representativeCustomer.id, customerId))
        .for("key share");
    }
    const held = await findOrMakeIdentity(tx, userId, heard);
    if (held.identityId === identityId && held.customerId === customerId) return held;
  }
}

/** Whether this message's sender is verified, with the identity's standing moved on by it. */
async function judgeMessage(
  tx: Transaction,
  identityId: string,
  proof: ChannelProof | undefined,
  now: Date,
) {
  const where = eq(representativeCustomerIdentity.id, identityId);
  const [standing] = await tx
    .select({
      verifiedContactAt: representativeCustomerIdentity.verifiedContactAt,
      lapsedAt: representativeCustomerIdentity.lapsedAt,
      provenUntil: representativeCustomerIdentity.provenUntil,
    })
    .from(representativeCustomerIdentity)
    .where(where)
    .for("update");
  const judged = judgeSender(standing!, proof, now);
  await tx.update(representativeCustomerIdentity).set(judged.standing).where(where);
  return judged.verified;
}

/**
 * Stores a Customer's message on its thread, whether or not a Turn can run: `null` only when the
 * Representative doesn't exist. It holds that row, so the owner's delete, which removes
 * Representatives before Customers, can't leave a Customer behind. It also holds the thread's row
 * until `tx` ends, so what it returns of the thread's Turn stays true for the caller. A blocked
 * Customer's message is stored all the same, for the owner (ticket #1251), and waits for no Turn. A
 * message holding the sender's code is stored as a note of what became of the code instead (ticket
 * #1256), so no model or prompt ever reads it.
 */
export async function receiveMessage(
  tx: Transaction,
  {
    services,
    representativeId,
    heard,
    proof,
    text,
    now,
  }: {
    services: Pick<FeatureContext, "clock" | "jobs" | "keyring">;
    representativeId: string;
    heard: Heard;
    proof: ChannelProof | undefined;
    text: string;
    now: Date;
  },
) {
  const [owner] = await tx
    .select({ userId: representative.userId })
    .from(representative)
    .where(eq(representative.id, representativeId))
    .for("key share");
  if (!owner) return null;
  const { identityId, customerId: heldCustomerId } = await holdSender(
    tx,
    owner.userId,
    heard,
    text,
    now,
  );
  const [customer] = await tx
    .select({ blockedAt: representativeCustomer.blockedAt })
    .from(representativeCustomer)
    .where(eq(representativeCustomer.id, heldCustomerId));
  const blocked = customer!.blockedAt !== null;
  const stored = await catchCode(tx, {
    services,
    identityId,
    customerId: heldCustomerId,
    blocked,
    text,
    now,
  });
  // Passing a code can have merged their Customer into another, whose thread this goes on.
  const customerId = stored === text ? heldCustomerId : await customerOfIdentity(tx, identityId);
  // A blocked Customer's messages renew nothing, so the lapse runs on through a block.
  const verified = !blocked && (await judgeMessage(tx, identityId, proof, now));
  const [thread] = await tx
    .insert(representativeThread)
    .values({
      id: uuidv7(),
      customerId,
      representativeId,
      lastChannel: heard.channel,
      lastExternalId: heard.externalId,
      messageCount: 1,
      ...(!blocked && { waitingFrom: 1, waitingSince: now }),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [representativeThread.customerId, representativeThread.representativeId],
      targetWhere: sql`state <> 'closed'`,
      set: {
        ...(verified && { lastChannel: heard.channel, lastExternalId: heard.externalId }),
        messageCount: sql`${representativeThread.messageCount} + 1`,
        ...(!blocked && {
          waitingFrom: sql`coalesce(${representativeThread.waitingFrom}, ${representativeThread.messageCount} + 1)`,
          waitingSince: sql`coalesce(${representativeThread.waitingSince}, ${now.toISOString()}::timestamp)`,
        }),
        updatedAt: sql`greatest(${representativeThread.updatedAt}, ${now.toISOString()}::timestamp)`,
      },
    })
    .returning({
      id: representativeThread.id,
      position: representativeThread.messageCount,
      turnId: representativeThread.turnId,
      waitingSince: representativeThread.waitingSince,
      state: representativeThread.state,
    });
  const { id: threadId, position, turnId, waitingSince, state } = thread!;
  await tx.insert(representativeThreadMessage).values({
    id: uuidv7(),
    threadId,
    position,
    author: "customer",
    text: stored,
    verified,
    proofRule: proof?.rule,
    ...heard,
  });
  // Position 1 is a thread's first message: it has just been opened.
  return { threadId, turnId, waitingSince, blocked, state, opened: position === 1 };
}

/**
 * Who a Turn answers, from the message at `position`, and the rule their Channel checks them by, from
 * their newest message up to `upTo`: a batch can start on a Bot's result, which no Channel carried.
 * Undefined once the thread has gone.
 */
export async function readSender(
  db: FeatureContext["db"],
  threadId: string,
  position: number,
  upTo: number,
) {
  const message = representativeThreadMessage;
  const [sender] = await db
    .select({ channel: message.channel, externalId: message.externalId })
    .from(message)
    .where(and(eq(message.threadId, threadId), eq(message.position, position)));
  if (!sender) return undefined;
  const [heard] = await db
    .select({ proofRule: message.proofRule })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        lte(message.position, upTo),
        eq(message.author, "customer"),
        eq(message.channel, sender.channel),
        eq(message.externalId, sender.externalId),
      ),
    )
    .orderBy(desc(message.position))
    .limit(1);
  return { ...sender, proofRule: heard?.proofRule ?? null };
}

/**
 * What a Turn reads of its thread: oldest first, up to and including `upTo`, so a replay reads what
 * the first attempt read, and within both limits. Empty once the thread has gone. For an unverified
 * sender, only what that identity said while unverified and the replies to it: nothing from the
 * Customer's other identities, and nothing from this identity's verified past, since a spoofed
 * number or a recycled one is that identity too.
 */
export async function readThread(
  db: FeatureContext["db"],
  threadId: string,
  upTo: number,
  batchFrom: number,
  unverifiedSender: Heard | null,
): Promise<ThreadEntry[]> {
  const newest = await db
    .select({
      position: representativeThreadMessage.position,
      author: representativeThreadMessage.author,
      text: representativeThreadMessage.text,
      verified: representativeThreadMessage.verified,
      heldForOwner: representativeThreadMessage.heldForOwner,
      assignmentId: representativeThreadMessage.assignmentId,
    })
    .from(representativeThreadMessage)
    .where(
      and(
        eq(representativeThreadMessage.threadId, threadId),
        lte(representativeThreadMessage.position, upTo),
        unverifiedSender
          ? and(
              eq(representativeThreadMessage.verified, false),
              eq(representativeThreadMessage.channel, unverifiedSender.channel),
              eq(representativeThreadMessage.externalId, unverifiedSender.externalId),
            )
          : undefined,
      ),
    )
    .orderBy(desc(representativeThreadMessage.position))
    .limit(threadPromptLimit);
  const kept: typeof newest = [];
  let chars = 0;
  for (const entry of newest) {
    chars += entry.text.length;
    if (chars > threadPromptChars) break;
    kept.push(entry);
  }
  // A message that waited through the last Turn comes after that Turn's reply, though sent before
  // it: a Turn's prompt ends on what it has to answer.
  const unanswered = (entry: (typeof newest)[number]) =>
    (entry.author === "customer" || entry.author === "bot") && entry.position >= batchFrom;
  kept.reverse();
  return [...kept.filter((entry) => !unanswered(entry)), ...kept.filter(unanswered)].map(
    ({ author, text, verified, position, heldForOwner, assignmentId }) => {
      const earlier = position < batchFrom || heldForOwner;
      return {
        author,
        text,
        verified,
        earlier,
        ...(assignmentId && !earlier && { assignmentId }),
      };
    },
  );
}

/**
 * Stores a reply as sent to the sender its Turn answers, if the Representative still holds the
 * thread. Not to whoever was heard last: an unverified identity writing during a verified Turn
 * mustn't get that Turn's reply.
 */
export async function storeReply(
  tx: Transaction,
  { threadId, heard, verified }: { threadId: string; heard: Heard; verified: boolean },
  { text, sources }: { text: string; sources: ReplySource[] },
  replyKind: ReplyKind,
  now: Date,
) {
  const [thread] = await tx
    .update(representativeThread)
    .set({
      messageCount: sql`${representativeThread.messageCount} + 1`,
      turnFrom: null,
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
    .returning({ position: representativeThread.messageCount });
  if (!thread)
    return {
      error:
        "This thread is gone or no longer yours to answer (it may be held by the owner, or its Customer blocked), so nothing was sent.",
    };
  await tx.insert(representativeThreadMessage).values({
    id: uuidv7(),
    threadId,
    author: "representative",
    text,
    replyKind,
    sources,
    verified,
    ...heard,
    ...thread,
  });
  return { sent: true };
}

/** `rows` by the key `keyOf` gives, each group in the order given. */
export function grouped<T>(rows: T[], keyOf: (row: T) => string) {
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
    .select({
      id: representativeCustomer.id,
      name: representativeCustomer.name,
      blockedAt: representativeCustomer.blockedAt,
      createdAt: representativeCustomer.createdAt,
    })
    .from(representativeCustomer)
    .where(eq(representativeCustomer.userId, userId))
    .orderBy(asc(representativeCustomer.createdAt), asc(representativeCustomer.id));
  const identities = grouped(
    await tx
      .select({
        customerId: representativeCustomerIdentity.customerId,
        channel: representativeCustomerIdentity.channel,
        externalId: representativeCustomerIdentity.externalId,
        verifiedContactAt: representativeCustomerIdentity.verifiedContactAt,
        lapsedAt: representativeCustomerIdentity.lapsedAt,
        provenUntil: representativeCustomerIdentity.provenUntil,
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
        verified: representativeThreadMessage.verified,
        replyKind: representativeThreadMessage.replyKind,
        sources: representativeThreadMessage.sources,
        assignmentId: representativeThreadMessage.assignmentId,
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
  return customers.map(({ id, name, blockedAt, createdAt }) => ({
    id,
    name,
    blockedAt,
    createdAt,
    identities: (identities.get(id) ?? []).map((row) => ({
      channel: row.channel,
      externalId: row.externalId,
      verifiedContactAt: row.verifiedContactAt,
      lapsedAt: row.lapsedAt,
      provenUntil: row.provenUntil,
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
        verified: message.verified,
        replyKind: message.replyKind,
        sources: message.sources,
        assignmentId: message.assignmentId,
        createdAt: message.createdAt,
      })),
    })),
  }));
}

/** Removes `userId`'s Customers; their identities and threads go with them (foreign keys cascade). */
export async function deleteCustomers(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(representativeCustomer).where(eq(representativeCustomer.userId, userId));
}
