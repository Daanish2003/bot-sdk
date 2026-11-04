import { and, eq, sql } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import {
  representative,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";
import { deliverMessage, dropHeld, passGate } from "./outbound-gate";
import { getThread } from "./owner-customers";
import { lockThread, refusedByGate, threadClosed } from "./takeover";

/*
 * What the owner does with a message the Outbound gate held (ticket #1304): send it or drop it. Only a
 * quiet-hours hold lets itself go; one held by a cap or a Channel's rules waits here. Each is a
 * decision in the log, and a new Customer message drops what is held (`receiveMessage`).
 */

type Context = Pick<FeatureContext, "db" | "clock" | "jobs">;

const heldNotFound = () =>
  rpcError("NOT_FOUND", "error.heldMessageNotFound", "Held message not found");

/** The held message `heldId` of one of `userId`'s threads, and the thread it is on; null when neither is theirs. */
async function ownedHeld(tx: Transaction, userId: string, heldId: string) {
  const held = representativeHeldMessage;
  const [row] = await tx
    .select({ threadId: held.threadId })
    .from(held)
    .innerJoin(representativeThread, eq(representativeThread.id, held.threadId))
    .innerJoin(
      representative,
      and(
        eq(representative.id, representativeThread.representativeId),
        eq(representative.userId, userId),
      ),
    )
    .where(eq(held.id, heldId));
  return row?.threadId ?? null;
}

/**
 * Sends the held message as the owner's, if the gate still passes it: a Customer blocked since gets
 * nothing, and the message stays held for the owner to drop. The thread is the owner's to write in
 * only as the Representative's: it need not be held.
 */
export async function sendHeldMessage(context: Context, userId: string, heldId: string) {
  const sent = await context.db.transaction(async (tx) => {
    const found = await ownedHeld(tx, userId, heldId);
    if (!found) throw heldNotFound();
    const thread = await lockThread(tx, userId, found);
    if (thread.state === "closed") throw threadClosed();
    // Read again under the thread's lock: another send or a new Customer message may have taken it.
    const held = representativeHeldMessage;
    const decision = representativeOutboundDecision;
    const [message] = await tx
      .select({
        text: held.text,
        verified: held.verified,
        replyKind: held.replyKind,
        sources: held.sources,
        channel: decision.channel,
        externalId: decision.externalId,
      })
      .from(held)
      .innerJoin(decision, eq(decision.id, held.decisionId))
      .where(eq(held.id, heldId))
      .for("update", { of: held });
    if (!message) throw heldNotFound();
    const now = context.clock();
    const { channel, externalId } = message;
    const decided = await passGate(tx, {
      kind: "released",
      threadId: found,
      to: { channel, externalId },
      now,
      content: { text: message.text, verified: message.verified },
    });
    if (!decided) throw heldNotFound();
    if (decided.outcome !== "send") {
      return { blocked: true as const, rule: decided.rule, threadId: found };
    }
    const [updated] = await tx
      .update(representativeThread)
      .set({
        messageCount: sql`${representativeThread.messageCount} + 1`,
        updatedAt: sql`greatest(${representativeThread.updatedAt}, ${now.toISOString()}::timestamp)`,
      })
      .where(eq(representativeThread.id, found))
      .returning({ position: representativeThread.messageCount });
    const messageId = uuidv7();
    await tx.insert(representativeThreadMessage).values({
      id: messageId,
      threadId: found,
      position: updated!.position,
      author: "representative",
      text: message.text,
      replyKind: message.replyKind,
      sources: message.sources,
      verified: message.verified,
      channel,
      externalId,
    });
    await tx.delete(held).where(eq(held.id, heldId));
    await deliverMessage(context, tx, decided.id, messageId);
    return { blocked: false as const, threadId: found };
  });
  // After the commit, so the decision stays in the log.
  if (sent.blocked) throw refusedByGate(sent.rule);
  return getThread(context, userId, sent.threadId);
}

/** Drops the held message: the Customer never gets it. */
export async function dropHeldMessage(context: Context, userId: string, heldId: string) {
  const threadId = await context.db.transaction(async (tx) => {
    const found = await ownedHeld(tx, userId, heldId);
    if (!found) throw heldNotFound();
    // The thread's lock first, the order a Customer's message takes it in.
    await lockThread(tx, userId, found);
    const dropped = await dropHeld(tx, {
      threadId: found,
      heldId,
      kind: "owner",
      rule: "owner_dropped",
      now: context.clock(),
    });
    if (dropped === 0) throw heldNotFound();
    return found;
  });
  return getThread(context, userId, threadId);
}
