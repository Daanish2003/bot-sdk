import { and, desc, eq, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import {
  representative,
  representativeInboundMail,
  representativeThread,
  representativeThreadMail,
} from "./db/schema";

/*
 * What a thread's email needs to be answered in the same subject thread (ticket #1347). A Customer's
 * mail leaves its subject and its Message-ID chain here; a reply by email reads them, and leaves its
 * own Message-ID on the chain.
 */

/** The most Message-IDs kept per thread: the newest, which is what a long thread's References needs. */
const chainLimit = 50;

/** The Message-IDs in a References or In-Reply-To header, oldest first, without their angle brackets. */
export function messageIdsOf(header: string | undefined): string[] {
  return [...(header ?? "").matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]!);
}

/** `ids` after the stored `chain`, with any already there left where they were. */
function joined(chain: readonly string[], ids: readonly string[]): string[] {
  // An id met again moves to its newest place, so the last is always the newest mail.
  const fresh = new Set(ids);
  return [...chain.filter((id) => !fresh.has(id)), ...fresh].slice(-chainLimit);
}

/** Adds `ids` to the thread's chain under its row's lock, and sets `subject` when given. */
async function extendChain(
  tx: Transaction,
  threadId: string,
  ids: readonly string[],
  subject?: string,
) {
  const [kept] = await tx
    .select({ ids: representativeThreadMail.messageIds, subject: representativeThreadMail.subject })
    .from(representativeThreadMail)
    .where(eq(representativeThreadMail.threadId, threadId))
    .for("update");
  const row = {
    subject: subject ?? kept?.subject ?? "",
    messageIds: joined(kept?.ids ?? [], ids),
  };
  await tx
    .insert(representativeThreadMail)
    .values({ threadId, ...row })
    .onConflictDoUpdate({ target: representativeThreadMail.threadId, set: row });
}

/**
 * Whether a mail to the Representative's address is new: false for a redelivery of one it took
 * already, which a provider can send to another process or after a restart. In the transaction that
 * stores the message, so a copy delivered meanwhile waits for it and is then refused. True when the
 * Representative is gone, for the caller to find.
 */
export async function isNewMail(tx: Transaction, representativeId: string, messageId: string) {
  // The Representative's row first, as a Customer's message takes it.
  const [held] = await tx
    .select({ id: representative.id })
    .from(representative)
    .where(eq(representative.id, representativeId))
    .for("key share");
  if (!held) return true;
  const taken = await tx
    .insert(representativeInboundMail)
    .values({ representativeId, messageId })
    .onConflictDoNothing()
    .returning({ messageId: representativeInboundMail.messageId });
  return taken.length > 0;
}

/** Records a Customer's mail on its thread, in the transaction that stores the message. */
export async function keepThreadMail(
  tx: Transaction,
  threadId: string,
  mail: { messageId: string; subject: string; references: readonly string[] },
) {
  await extendChain(tx, threadId, [...mail.references, mail.messageId], mail.subject);
}

/** The newest thread of the Customer at email address `externalId` and its mail so far, if any. */
export async function threadMailOf(
  tx: FeatureContext["db"] | Transaction,
  { representativeId, externalId }: { representativeId: string; externalId: string },
) {
  const [row] = await tx
    .select({
      threadId: representativeThread.id,
      subject: representativeThreadMail.subject,
      messageIds: representativeThreadMail.messageIds,
    })
    .from(representativeThread)
    .innerJoin(
      representativeThreadMail,
      eq(representativeThreadMail.threadId, representativeThread.id),
    )
    .where(
      and(
        eq(representativeThread.representativeId, representativeId),
        eq(representativeThread.lastChannel, "email"),
        eq(representativeThread.lastExternalId, externalId),
      ),
    )
    // The open thread first: a reply answers the conversation the Customer is in.
    .orderBy(sql`${representativeThread.state} = 'closed'`, desc(representativeThread.updatedAt))
    .limit(1);
  return row ?? null;
}

/** Puts a mail the Representative sent on the thread's chain, so the Customer's answer to it is kept in thread. */
export async function keepSentMail(tx: Transaction, threadId: string, messageId: string) {
  await extendChain(tx, threadId, [messageId]);
}
