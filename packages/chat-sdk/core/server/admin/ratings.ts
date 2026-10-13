import { and, gte, isNotNull, sql } from "drizzle-orm";

import { message } from "../db/schema/chat";
import type { AppDeps } from "../deps";

/** One Model's 👍 and 👎 Ratings over a range (spec #277). Never per user, never per Message. */
export type RatingTotal = {
  model: string;
  up: number;
  down: number;
};

/**
 * The 👍 and 👎 counts per Model over Messages whose Rating was stamped at or after `since` (spec
 * #277). Live counts: a deleted Message drops out. A Model with no Rating in range has no row.
 */
export async function ratingTotals(
  deps: Pick<AppDeps, "db">,
  { since }: { since: Date },
): Promise<RatingTotal[]> {
  const rows = await deps.db
    .select({
      model: message.model,
      up: sql<number>`count(*) filter (where ${message.rating} = 'up')::int`,
      down: sql<number>`count(*) filter (where ${message.rating} = 'down')::int`,
    })
    .from(message)
    .where(and(isNotNull(message.rating), isNotNull(message.model), gte(message.ratedAt, since)))
    .groupBy(message.model);
  return rows.map((row) => ({ model: row.model!, up: row.up, down: row.down }));
}
