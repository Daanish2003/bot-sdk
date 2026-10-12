import { and, eq, gte, lt, sql } from "drizzle-orm";

import { usage } from "../db/schema/usage";
import type { AppDeps, Quota, QuotaSetting } from "../deps";

/** The error code a refused Run answers with (HTTP 402), so a client can tell it from other refusals. */
export const quotaExceededCode = "quota_exceeded";

/** The `getQuota` a Host passed, as the one function the SDK calls per user (ADR 0007). */
export function quotaLookup(
  setting: QuotaSetting | undefined,
): (userId: string) => Promise<Quota | null> {
  if (typeof setting === "function") return async (userId) => setting(userId);
  return async () => setting ?? null;
}

/** The window `now` falls in: a fixed UTC day or calendar month, and when it resets (ADR 0007). */
export function quotaWindow(window: Quota["window"], now: Date) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  if (window === "day") {
    return {
      start: new Date(Date.UTC(year, month, day)),
      resetsAt: new Date(Date.UTC(year, month, day + 1)),
    };
  }
  return {
    start: new Date(Date.UTC(year, month, 1)),
    resetsAt: new Date(Date.UTC(year, month + 1, 1)),
  };
}

/** A user's Quota as it stands now: its budget and spend in micros, and when its window resets. */
async function quotaState(deps: Pick<AppDeps, "db" | "getQuota">, userId: string) {
  const quota = await deps.getQuota(userId);
  if (!quota) return null;
  const now = new Date();
  const { start, resetsAt } = quotaWindow(quota.window, now);
  const [row] = await deps.db
    .select({ spent: sql<string>`coalesce(sum(${usage.costMicros}), 0)` })
    .from(usage)
    .where(
      and(eq(usage.userId, userId), gte(usage.createdAt, start), lt(usage.createdAt, resetsAt)),
    );
  return {
    window: quota.window,
    resetsAt,
    budgetMicros: Math.round(quota.budgetUsd * 1_000_000),
    spentMicros: Number(row?.spent ?? 0),
  };
}

/**
 * Why a Run on Host credentials must not start: the reset time, once the window's spend reaches
 * the budget. `null` when the Run may start (ADR 0007). Checked before the Run, never mid-stream.
 */
export async function quotaRefusal(
  deps: Pick<AppDeps, "db" | "getQuota">,
  userId: string,
): Promise<{ resetsAt: Date } | null> {
  const state = await quotaState(deps, userId);
  if (!state || state.spentMicros < state.budgetMicros) return null;
  return { resetsAt: state.resetsAt };
}

/** The Quota read: the used percentage, the window and its reset time, never money (ADR 0007). */
export async function readQuota(
  deps: Pick<AppDeps, "db" | "getQuota">,
  userId: string,
): Promise<{ usedPercent: number; window: Quota["window"]; resetsAt: Date } | null> {
  const state = await quotaState(deps, userId);
  if (!state) return null;
  const usedPercent =
    state.budgetMicros > 0
      ? Math.min(100, Math.floor((state.spentMicros / state.budgetMicros) * 100))
      : 100;
  return { usedPercent, window: state.window, resetsAt: state.resetsAt };
}
