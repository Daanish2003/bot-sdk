import { and, eq, gte, lt, sql } from "drizzle-orm";

import { usage } from "../../../core/server/db/schema";
import type { RunUsage } from "../../assistant/server/chat/usage";
import type { MessageUsage } from "../../../core/shared/chat/message-record";
import type { ModelsDeps } from "./types";

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
  deps: Pick<ModelsDeps, "db">,
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
  deps: Pick<ModelsDeps, "db">,
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

/**
 * The usage a Run stores when it ends: what the Provider reported for a Run that completed, or,
 * when it didn't (stopped, failed or no usage reported), a characters ÷ 4 estimate of the prompt
 * and the reply's streamed text and thinking, flagged `estimated`.
 */
export function messageUsage(
  reported: RunUsage | undefined,
  {
    promptCharacters,
    parts,
  }: { promptCharacters: number; parts: { type: string; text?: string }[] },
): MessageUsage {
  if (reported) return { ...reported, estimated: false };
  let thinking = 0;
  let text = 0;
  for (const part of parts) {
    if (part.type === "text") text += part.text?.length ?? 0;
    if (part.type === "thinking") thinking += part.text?.length ?? 0;
  }
  return {
    input: tokensOf(promptCharacters),
    output: tokensOf(text + thinking),
    reasoning: tokensOf(thinking),
    cached: 0,
    estimated: true,
  };
}

/** A quarter of a token per character, rounded up. */
const tokensOf = (characters: number) => Math.ceil(characters / 4);
