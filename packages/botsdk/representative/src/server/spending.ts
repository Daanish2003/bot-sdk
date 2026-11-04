import { and, count, desc, eq, gt, gte, sql } from "drizzle-orm";

import type { Transaction } from "@botsdk/bot/plugin";
import { usage } from "@botsdk/bot/storage";
import { defaultSpendingCaps, type SpendingCaps } from "../shared/contract";
import {
  representative,
  representativeThread,
  representativeThreadMessage,
  representativeTurn,
} from "./db/schema";

/*
 * What a Representative may cost (ticket #1310). The caps count usage rows: a thread's and a Customer's
 * count only the calls of their Turns, kept by `representativeTurn`, and a month's counts those and the
 * Customer memory passes too. A test conversation has no Turn row, and an Assignment's calls are a
 * Bot's, so neither counts. A cap is reached when its limit is: the call at the limit is the last.
 */

/** Which cap was reached, as the limit's Page cause. */
export type SpendingCause = "thread_cap" | "customer_cap" | "stranger_cap" | "month_cap";

const dayMs = 24 * 60 * 60_000;

type Reader = Pick<Transaction, "select">;

/** The calls and money of a Representative's Turns that `where` picks, from `since` on. */
async function turnSpend(
  db: Reader,
  where: ReturnType<typeof eq>,
  since: Date | null,
): Promise<{ calls: number; micros: number }> {
  const [row] = await db
    .select({
      calls: count(),
      micros: sql<string>`coalesce(sum(${usage.costMicros}), 0)`,
    })
    .from(usage)
    .innerJoin(representativeTurn, eq(usage.sourceId, sql`${representativeTurn.id}::text`))
    .innerJoin(representativeThread, eq(representativeThread.id, representativeTurn.threadId))
    .where(
      and(eq(usage.kind, "representative"), where, since ? gt(usage.createdAt, since) : undefined),
    );
  return { calls: row?.calls ?? 0, micros: Number(row?.micros ?? 0) };
}

/** The money a Representative's Turns and Customer memory passes cost in the UTC calendar month of `now`. */
export async function monthSpendMicros(db: Reader, representativeId: string, now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [turns] = await db
    .select({ micros: sql<string>`coalesce(sum(${usage.costMicros}), 0)` })
    .from(usage)
    .innerJoin(representativeTurn, eq(usage.sourceId, sql`${representativeTurn.id}::text`))
    .where(
      and(
        eq(usage.kind, "representative"),
        eq(representativeTurn.representativeId, representativeId),
        gte(usage.createdAt, start),
      ),
    );
  const [passes] = await db
    .select({ micros: sql<string>`coalesce(sum(${usage.costMicros}), 0)` })
    .from(usage)
    .innerJoin(representativeThread, eq(usage.sourceId, sql`${representativeThread.id}::text`))
    .where(
      and(
        eq(usage.kind, "customer_memory"),
        eq(representativeThread.representativeId, representativeId),
        gte(usage.createdAt, start),
      ),
    );
  return Number(turns?.micros ?? 0) + Number(passes?.micros ?? 0);
}

/** How much of its monthly cap a Representative has used at `now`, 0 to 100. */
export async function monthUsedPercent(
  db: Reader,
  representativeId: string,
  caps: SpendingCaps,
  now: Date,
) {
  const spent = await monthSpendMicros(db, representativeId, now);
  return Math.min(100, Math.floor((spent / caps.monthMicros) * 100));
}

/**
 * The first cap thread `threadId` has reached at `now`, or null: the thread's own, then its Customer's
 * for the day (the lower one when the Customer's newest message is unverified), then the Representative's
 * for the month.
 */
export async function capReached(
  db: Reader,
  threadId: string,
  now: Date,
): Promise<SpendingCause | null> {
  const [thread] = await db
    .select({
      customerId: representativeThread.customerId,
      representativeId: representativeThread.representativeId,
      caps: representative.spendingCaps,
    })
    .from(representativeThread)
    .innerJoin(representative, eq(representative.id, representativeThread.representativeId))
    .where(eq(representativeThread.id, threadId));
  if (!thread) return null;
  const caps = { ...defaultSpendingCaps, ...thread.caps };
  const inThread = await turnSpend(db, eq(representativeThread.id, threadId), null);
  if (inThread.calls >= caps.threadCalls || inThread.micros >= caps.threadMicros) {
    return "thread_cap";
  }
  const [newest] = await db
    .select({ verified: representativeThreadMessage.verified })
    .from(representativeThreadMessage)
    .where(
      and(
        eq(representativeThreadMessage.threadId, threadId),
        eq(representativeThreadMessage.author, "customer"),
      ),
    )
    .orderBy(desc(representativeThreadMessage.position))
    .limit(1);
  const stranger = newest?.verified === false;
  const today = await turnSpend(
    db,
    eq(representativeThread.customerId, thread.customerId),
    new Date(now.getTime() - dayMs),
  );
  const [calls, micros] = stranger
    ? [caps.strangerCalls, caps.strangerMicros]
    : [caps.customerCalls, caps.customerMicros];
  if (today.calls >= calls || today.micros >= micros) {
    return stranger ? "stranger_cap" : "customer_cap";
  }
  const month = await monthSpendMicros(db, thread.representativeId, now);
  return month >= caps.monthMicros ? "month_cap" : null;
}
