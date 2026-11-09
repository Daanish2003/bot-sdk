import { and, desc, eq, gt, inArray } from "drizzle-orm";

import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import {
  customerAuthors,
  representative,
  representativeThread,
  representativeThreadMessage,
} from "./db/schema";

/*
 * Inbound is limited per identity (ticket #1311): at most `inboundLimit` messages in any hour, so a
 * flood can't drive costs. The count is the identity's stored messages of the last hour, so an extra
 * one, which is logged and never stored, adds nothing to it, and the identity is heard again as the
 * hour moves on. `STOP`, `START` and an emergency keyword are exempt, the caller's to decide.
 */

export const inboundLimit = 60;
const windowMs = 60 * 60_000;

/**
 * How long until the owner's identity at `heard` is heard again, in milliseconds, when it has already
 * sent the limit's worth of messages in the last hour; null while it hasn't. It's heard again once the
 * oldest of its newest `inboundLimit` messages leaves the hour.
 */
export async function overInboundLimit(
  db: FeatureContext["db"] | Transaction,
  userId: string,
  heard: { channel: string; externalId: string },
  now: Date,
): Promise<number | null> {
  const message = representativeThreadMessage;
  const [oldest] = await db
    .select({ createdAt: message.createdAt })
    .from(message)
    .innerJoin(representativeThread, eq(representativeThread.id, message.threadId))
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .where(
      and(
        eq(representative.userId, userId),
        inArray(message.author, customerAuthors),
        eq(message.channel, heard.channel),
        eq(message.externalId, heard.externalId),
        gt(message.createdAt, new Date(now.getTime() - windowMs)),
      ),
    )
    .orderBy(desc(message.createdAt))
    .offset(inboundLimit - 1)
    .limit(1);
  return oldest ? oldest.createdAt.getTime() + windowMs - now.getTime() : null;
}
