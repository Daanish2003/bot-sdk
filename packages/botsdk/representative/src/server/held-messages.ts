import { ORPCError } from "@orpc/contract";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { z } from "zod";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { rpcError } from "@botsdk/bot/rpc-error";
import {
  draftRule,
  representative,
  representativeHeldMessage,
  representativeOutboundDecision,
  representativeThread,
} from "./db/schema";
import { defineJob } from "@botsdk/bot/runner/internal";
import {
  dropHeld,
  enqueueHeldRelease,
  heldReleaseJobName,
  heldReleasePayload,
  passGate,
  quietAt,
  storeAndDeliver,
} from "./outbound-gate";
import { getThread } from "./owner-customers";
import { lockThread, refusedByGate, threadClosed } from "./takeover";

/*
 * What the owner does with a message the Outbound gate held (ticket #1304): send it or drop it. Only a
 * quiet-hours hold lets itself go (`heldReleaseJob`, ticket #1303); one held by a cap or a Channel's
 * rules waits here. Each is a decision in the log, and a new Customer message drops what is held
 * (`receiveMessage`).
 */

type Context = Pick<FeatureContext, "db" | "clock" | "jobs"> &
  Partial<Pick<FeatureContext<"pages">, "pages">>;

const heldNotFound = () =>
  rpcError("NOT_FOUND", "error.heldMessageNotFound", "Held message not found");

/**
 * The held message `heldId` of one of `userId`'s threads, and the thread it is on; null when neither
 * is theirs. Never a Reply draft, which the owner answers in `reply-drafts`, nor anything answered.
 */
async function ownedHeld(tx: Transaction, userId: string, heldId: string) {
  const held = representativeHeldMessage;
  const [row] = await tx
    .select({ threadId: held.threadId })
    .from(held)
    .innerJoin(
      representativeOutboundDecision,
      eq(representativeOutboundDecision.id, held.decisionId),
    )
    .innerJoin(representativeThread, eq(representativeThread.id, held.threadId))
    .innerJoin(
      representative,
      and(
        eq(representative.id, representativeThread.representativeId),
        eq(representative.userId, userId),
      ),
    )
    .where(
      and(
        eq(held.id, heldId),
        isNull(held.resolution),
        ne(representativeOutboundDecision.rule, draftRule),
      ),
    );
  return row?.threadId ?? null;
}

/**
 * Sends the held message as the owner's, if the gate still passes it: a Customer blocked since gets
 * nothing, and the message stays held for the owner to drop. The thread is the owner's to write in
 * only as the Representative's: it need not be held.
 */
export async function sendHeldMessage(context: Context, userId: string, heldId: string) {
  const sent = await releaseHeld(context, userId, heldId, false);
  // After the commit, so the decision stays in the log.
  if (sent.blocked) throw refusedByGate(sent.rule);
  return getThread(context, userId, sent.threadId);
}

/**
 * The send behind `sendHeldMessage`. `byItself` is a quiet-hours hold going when they end: the owner
 * holding the thread since keeps it held for them, as nothing is sent while they hold it.
 */
async function releaseHeld(context: Context, userId: string, heldId: string, byItself: boolean) {
  return context.db.transaction(async (tx) => {
    const found = await ownedHeld(tx, userId, heldId);
    if (!found) throw heldNotFound();
    const thread = await lockThread(tx, userId, found);
    if (thread.state === "closed") throw threadClosed();
    if (byItself && thread.state !== "representative") {
      return { blocked: false as const, threadId: found };
    }
    // Read again under the thread's lock: another send or a new Customer message may have taken it.
    const held = representativeHeldMessage;
    const decision = representativeOutboundDecision;
    const [message] = await tx
      .select({
        text: held.text,
        verified: held.verified,
        replyKind: held.replyKind,
        sources: held.sources,
        topic: held.topic,
        channel: decision.channel,
        externalId: decision.externalId,
        rule: decision.rule,
      })
      .from(held)
      .innerJoin(decision, eq(decision.id, held.decisionId))
      .where(eq(held.id, heldId))
      .for("update", { of: held });
    if (!message) throw heldNotFound();
    const now = context.clock();
    const { channel, externalId } = message;
    if (byItself && message.rule === "quietHours") {
      // The hours or the Customer's zone may have changed since: it goes when they end now.
      const quiet = await quietAt(tx, found, now);
      if (quiet?.quiet) {
        await enqueueHeldRelease(context.jobs, tx, heldId, quiet.endsAt);
        return { blocked: false as const, threadId: found };
      }
    }
    const decided = await passGate(tx, {
      kind: "released",
      threadId: found,
      to: { channel, externalId },
      now,
      pages: context.pages,
      // Going by itself it also passes what the owner's own send needn't: the switch, the caps and the topic's mode.
      // Held again it leaves the one held row, and Pages unless others already wait.
      ...(byItself
        ? {
            releasing: heldId,
            content: {
              text: message.text,
              verified: message.verified,
              topic: message.topic ?? undefined,
              // The topic's mode alone isn't enough: its sources must belong to it.
              sources: message.sources ?? undefined,
            },
          }
        : { content: { text: message.text, verified: message.verified } }),
    });
    if (!decided) throw heldNotFound();
    if (byItself && decided.rule === "on") {
      // Switched off: it is dropped, as the gate drops a reply.
      await tx.delete(held).where(eq(held.id, heldId));
      return { blocked: false as const, threadId: found };
    }
    if (decided.outcome === "drop") {
      return { blocked: true as const, rule: decided.rule, threadId: found };
    }
    if (decided.outcome !== "send") {
      return { blocked: false as const, threadId: found };
    }
    await tx.delete(held).where(eq(held.id, heldId));
    await storeAndDeliver(
      context,
      tx,
      decided.id,
      {
        threadId: found,
        author: "representative",
        text: message.text,
        replyKind: message.replyKind,
        sources: message.sources,
        verified: message.verified,
        channel,
        externalId,
      },
      now,
    );
    return { blocked: false as const, threadId: found };
  });
}

/**
 * Sends a message held for quiet hours when they end, unless something has taken it since: the owner
 * sent or dropped it, or a new Customer message replaced it, and then there is nothing to send. A
 * Customer blocked since, or a closed thread, leaves it held for the owner to drop.
 */
export const heldReleaseJob = defineJob<z.infer<typeof heldReleasePayload>>({
  name: heldReleaseJobName,
  payload: heldReleasePayload,
  run: async ({ heldId }, job) => {
    const held = representativeHeldMessage;
    const [row] = await job.db
      .select({ userId: representative.userId })
      .from(held)
      .innerJoin(representativeThread, eq(representativeThread.id, held.threadId))
      .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
      .where(eq(held.id, heldId));
    if (!row) return;
    try {
      await releaseHeld(job, row.userId, heldId, true);
    } catch (error) {
      if (!(error instanceof ORPCError)) throw error;
    }
  },
});

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
