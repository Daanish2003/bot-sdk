import { and, count, eq, gt, ne, not } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { identityAddress } from "../shared/contract";
import { smsChannel } from "./customer-proof";
import type { Heard } from "./customers";
import {
  representative,
  representativeCall,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeThread,
} from "./db/schema";
import { inboundWindowMs, overInboundLimit } from "./inbound-limit";

/*
 * Whether a Customer may be served, asked without storing anything (ticket #1380), for a contact that
 * isn't a message. A message meets these same rules in `receiveMessage`, which holds its rows and
 * stores it whatever they say, and which keeps what a keyword exempts from the limit.
 */

export type DeclineReason =
  | "over_limit"
  | "blocked"
  | "opted_out"
  | "taken_over"
  | "off"
  | "no_release";

/**
 * The `externalId` number's Calls still going in the last hour, across the owner's Representatives,
 * but `except` itself. A finished Call counts as its entry instead, since it stops being
 * `in_progress` in the commit that adds that entry, so it never counts twice.
 */
async function liveCallsOf(
  db: FeatureContext["db"] | Transaction,
  userId: string,
  externalId: string,
  now: Date,
  except: { channelAccountId: string; callId: string } | undefined,
) {
  const call = representativeCall;
  const [row] = await db
    .select({ live: count() })
    .from(call)
    .innerJoin(representativeThread, eq(representativeThread.id, call.threadId))
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .where(
      and(
        eq(representative.userId, userId),
        eq(call.externalId, externalId),
        eq(call.status, "in_progress"),
        gt(call.startedAt, new Date(now.getTime() - inboundWindowMs)),
        except &&
          not(
            and(
              eq(call.channelAccountId, except.channelAccountId),
              eq(call.callId, except.callId),
            )!,
          ),
      ),
    );
  return row?.live ?? 0;
}

/**
 * Why the identity at `heard` can't be served by `representativeId` at `now`, or null when it can, a
 * stranger included. A Representative that no longer exists is off. The first that applies, in the
 * order a message meets them: its limit before its Customer is looked at, and nobody being there to
 * answer last. Takes no locks and writes nothing, so what it says can change as soon as it's said.
 * `exceptCall` is the Call asking, which a repeated start has already counted toward the limit.
 */
export async function declineReason(
  db: FeatureContext["db"] | Transaction,
  {
    representativeId,
    heard,
    now,
    exceptCall,
  }: {
    representativeId: string;
    heard: Heard;
    now: Date;
    exceptCall?: { channelAccountId: string; callId: string };
  },
): Promise<DeclineReason | null> {
  const [owner] = await db
    .select({
      userId: representative.userId,
      enabled: representative.enabled,
      releaseId: representative.liveReleaseId,
    })
    .from(representative)
    .where(eq(representative.id, representativeId));
  if (!owner) return "off";
  // As a message's sender is, so the same person isn't a stranger for how the number was written.
  const externalId = identityAddress(heard.channel, heard.externalId);
  const asStored = { channel: heard.channel, externalId };
  // Calls first: one ending between the two reads is counted twice, at worst one over, not missed.
  const liveCalls =
    heard.channel === smsChannel
      ? await liveCallsOf(db, owner.userId, externalId, now, exceptCall)
      : 0;
  if ((await overInboundLimit(db, owner.userId, asStored, now, liveCalls)) !== null) {
    return "over_limit";
  }
  const identity = representativeCustomerIdentity;
  const [known] = await db
    .select({
      blockedAt: representativeCustomer.blockedAt,
      optedOutAt: identity.optedOutAt,
      threadState: representativeThread.state,
    })
    .from(identity)
    .innerJoin(representativeCustomer, eq(representativeCustomer.id, identity.customerId))
    .leftJoin(
      representativeThread,
      and(
        eq(representativeThread.customerId, identity.customerId),
        eq(representativeThread.representativeId, representativeId),
        ne(representativeThread.state, "closed"),
      ),
    )
    .where(
      and(
        eq(identity.userId, owner.userId),
        eq(identity.channel, heard.channel),
        eq(identity.externalId, externalId),
      ),
    );
  if (known?.blockedAt) return "blocked";
  if (known?.optedOutAt) return "opted_out";
  if (known?.threadState === "owner") return "taken_over";
  if (!owner.enabled) return "off";
  return owner.releaseId ? null : "no_release";
}
