import { and, count, eq, gt } from "drizzle-orm";

import type { Transaction } from "@botsdk/bot/plugin";
import { representative, representativeThread, representativeThreadMessage } from "./db/schema";

/*
 * Inbound is limited per identity (ticket #1311): at most `inboundLimit` messages in any hour, so a
 * flood can't drive costs. The count is the identity's stored messages of the last hour, so an extra
 * one, which is logged and never stored, adds nothing to it, and the identity is heard again as the
 * hour moves on. `STOP`, `START` and an emergency keyword are exempt, the caller's to decide.
 */

export const inboundLimit = 60;
const windowMs = 60 * 60_000;

/** Whether the owner's identity at `heard` has already sent the limit's worth of messages in the last hour. */
export async function overInboundLimit(
  tx: Transaction,
  userId: string,
  heard: { channel: string; externalId: string },
  now: Date,
) {
  const message = representativeThreadMessage;
  const [row] = await tx
    .select({ n: count() })
    .from(message)
    .innerJoin(representativeThread, eq(representativeThread.id, message.threadId))
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .where(
      and(
        eq(representative.userId, userId),
        eq(message.author, "customer"),
        eq(message.channel, heard.channel),
        eq(message.externalId, heard.externalId),
        gt(message.createdAt, new Date(now.getTime() - windowMs)),
      ),
    );
  return row!.n >= inboundLimit;
}
