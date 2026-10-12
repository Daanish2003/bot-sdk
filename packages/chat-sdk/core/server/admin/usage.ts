import { and, gte, lt, sql } from "drizzle-orm";

import { usage } from "../db/schema/usage";
import type { AppDeps } from "../deps";

/** One user's calls on Host credentials over a range, in micros and tokens (spec #277). */
export type UsageTotal = {
  userId: string;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

/**
 * Every user's calls on Host credentials created in `[since, until)`, summed. Web searches count
 * too, as they do against a Quota. A user with no calls in the range has no row.
 */
export async function usageTotals(
  deps: Pick<AppDeps, "db">,
  { since, until }: { since: Date; until: Date },
): Promise<UsageTotal[]> {
  const rows = await deps.db
    .select({
      userId: usage.userId,
      costMicros: sql<string>`sum(${usage.costMicros})`,
      inputTokens: sql<string>`sum(${usage.inputTokens})`,
      outputTokens: sql<string>`sum(${usage.outputTokens})`,
      calls: sql<number>`count(*)::int`,
    })
    .from(usage)
    .where(and(gte(usage.createdAt, since), lt(usage.createdAt, until)))
    .groupBy(usage.userId);
  return rows.map((row) => ({
    userId: row.userId,
    costMicros: Number(row.costMicros),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    calls: row.calls,
  }));
}
