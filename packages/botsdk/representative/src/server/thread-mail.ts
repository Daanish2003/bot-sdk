import { and, desc, eq } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { representativeThread, representativeThreadMail } from "./db/schema";

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
  const seen = new Set(chain);
  return [...chain, ...ids.filter((id) => !seen.has(id) && seen.add(id))].slice(-chainLimit);
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
    .orderBy(desc(representativeThread.updatedAt))
    .limit(1);
  return row ?? null;
}

/** Puts a mail the Representative sent on the thread's chain, so the Customer's answer to it is kept in thread. */
export async function keepSentMail(tx: Transaction, threadId: string, messageId: string) {
  await extendChain(tx, threadId, [messageId]);
}
