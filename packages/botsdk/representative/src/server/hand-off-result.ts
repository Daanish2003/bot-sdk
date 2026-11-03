import { eq, sql } from "drizzle-orm";

import type { AssignmentEnded } from "@botsdk/bot";
import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import {
  representativeHandOff,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import { tryLockThread } from "./takeover";
import { wakeTurn } from "./thread-turns";

/*
 * A hand-off's result returns to its thread (ticket #1254). What the Bot finished with for the
 * Customer is stored in the thread as the Bot's message, addressed to the sender whose Turn handed
 * the work off, and then:
 * - the Representative holds the thread: a Turn is woken to tell the Customer, as a Customer's
 *   message would wake one;
 * - the owner holds it: it waits there for the owner to decide what is sent. No model call runs
 *   and nothing is sent by itself;
 * - the thread has closed, or its Customer is blocked: it is kept in the thread for the owner and
 *   goes no further. A closed thread is not reopened: only a Customer's message opens one.
 * A result with no `for_customer` is not stored, and nothing is sent.
 */

type Services = Pick<FeatureContext, "db" | "clock" | "jobs">;

/** Delivers `ended`, the end of a hand-off's Assignment, to its thread, in `tx`. */
export async function deliverHandOffResult(
  services: Services,
  tx: Transaction,
  ended: AssignmentEnded,
) {
  const text = ended.result?.forCustomer;
  if (!text) return;
  const [handOff] = await tx
    .select({
      threadId: representativeHandOff.threadId,
      channel: representativeHandOff.channel,
      externalId: representativeHandOff.externalId,
      verified: representativeHandOff.verified,
    })
    .from(representativeHandOff)
    .where(eq(representativeHandOff.assignmentId, ended.assignmentId));
  // A test conversation's, or its thread has gone.
  if (!handOff?.threadId || handOff.channel === null || handOff.externalId === null) return;
  const { threadId } = handOff;
  // Not the owner's: nothing is stored.
  const thread = await tryLockThread(tx, ended.userId, threadId);
  if (!thread) return;
  const now = services.clock();
  const nowSql = sql`${now.toISOString()}::timestamp`;
  const wakes = thread.state === "representative" && !thread.blockedAt;
  const [updated] = await tx
    .update(representativeThread)
    .set({
      messageCount: sql`${representativeThread.messageCount} + 1`,
      ...(thread.state !== "closed" && {
        updatedAt: sql`greatest(${representativeThread.updatedAt}, ${nowSql})`,
      }),
      ...(wakes && {
        waitingFrom: sql`coalesce(${representativeThread.waitingFrom}, ${representativeThread.messageCount} + 1)`,
        waitingSince: sql`coalesce(${representativeThread.waitingSince}, ${nowSql})`,
      }),
    })
    .where(eq(representativeThread.id, threadId))
    .returning({
      position: representativeThread.messageCount,
      waitingSince: representativeThread.waitingSince,
    });
  // A verified Turn's Customer is where they were last heard from verified, which they may have
  // moved since; an unverified one's is that sender, whom nothing moves.
  const sender = handOff.verified
    ? { channel: thread.lastChannel, externalId: thread.lastExternalId }
    : { channel: handOff.channel, externalId: handOff.externalId };
  await tx.insert(representativeThreadMessage).values({
    id: uuidv7(),
    threadId,
    position: updated!.position,
    author: "bot",
    text,
    verified: handOff.verified ?? false,
    ...sender,
  });
  if (wakes) {
    await wakeTurn(services, tx, {
      threadId,
      turnId: thread.turnId,
      waitingSince: updated!.waitingSince!,
    });
  }
}
