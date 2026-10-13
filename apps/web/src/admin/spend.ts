/** One user's spend on one Model on one UTC day, as `chat.admin.usage` returns it. */
export type DaySpendRow = { day: string; model: string; costMicros: number };

/** One day of the spend chart: its total, and each Model's share, in micros. */
export type DaySpend = { day: string; totalMicros: number; byModel: Record<string, number> };

const dayMs = 24 * 60 * 60 * 1000;

/** The `count` UTC days ending on `now`'s day, oldest first, as `YYYY-MM-DD`. */
export function lastDays(now: Date, count: number): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: count }, (_, index) =>
    new Date(today - (count - 1 - index) * dayMs).toISOString().slice(0, 10),
  );
}

/** The spend range of the detail page: the 30 UTC days ending on `now`'s day, today included. */
export function spendRange(now: Date): { since: Date; until: Date } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { since: new Date(today - 29 * dayMs), until: new Date(today + dayMs) };
}

/** Spend per day over `days`, split by Model; a day with no calls is zero, not missing. */
export function spendByDay(rows: DaySpendRow[], days: string[]): DaySpend[] {
  return days.map((day) => {
    const byModel: Record<string, number> = {};
    for (const row of rows) {
      if (row.day !== day) continue;
      byModel[row.model] = (byModel[row.model] ?? 0) + row.costMicros;
    }
    const totalMicros = Object.values(byModel).reduce((sum, micros) => sum + micros, 0);
    return { day, totalMicros, byModel };
  });
}
