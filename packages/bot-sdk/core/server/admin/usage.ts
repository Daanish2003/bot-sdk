import { and, eq, gte, lt, sql } from "drizzle-orm";

import { usage } from "../db/schema";
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

/** One user's calls on one Model on one UTC day, in micros and tokens (spec #277). */
export type UsageByDay = {
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  model: string;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

/**
 * One user's calls on Host credentials created in `[since, until)`, per UTC day and Model, summed
 * and ordered by day then Model (spec #277). A day or Model with no calls has no row.
 */
export async function usageByDay(
  deps: Pick<AppDeps, "db">,
  userId: string,
  { since, until }: { since: Date; until: Date },
): Promise<UsageByDay[]> {
  const day = sql<string>`to_char(${usage.createdAt}, 'YYYY-MM-DD')`;
  const rows = await deps.db
    .select({
      day,
      model: usage.model,
      costMicros: sql<string>`sum(${usage.costMicros})`,
      inputTokens: sql<string>`sum(${usage.inputTokens})`,
      outputTokens: sql<string>`sum(${usage.outputTokens})`,
      calls: sql<number>`count(*)::int`,
    })
    .from(usage)
    .where(and(eq(usage.userId, userId), gte(usage.createdAt, since), lt(usage.createdAt, until)))
    .groupBy(day, usage.model)
    .orderBy(day, usage.model);
  return rows.map((row) => ({
    day: row.day,
    model: row.model,
    costMicros: Number(row.costMicros),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    calls: row.calls,
  }));
}
