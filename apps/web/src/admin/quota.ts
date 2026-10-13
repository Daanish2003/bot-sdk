import { type Database, eq } from "@ai-chat/db";
import { userQuota } from "@ai-chat/db/schema/quota";

import { type HostEnv, quotaOf, quotaWindowOf } from "../host-models";

type Quota = { budgetUsd: number; window: "day" | "month" };

/**
 * A user's Quota on the Host's Models (spec #277). An Admin's override wins: a budget of null is
 * unlimited, 0 turns Host Models off. With no row, the Host's default (`HOST_QUOTA_*`) applies.
 * The window is always the Host's (`HOST_QUOTA_WINDOW`). `null` means unlimited.
 */
export async function getQuota(db: Database, env: HostEnv, userId: string): Promise<Quota | null> {
  const override = await db.query.userQuota.findFirst({
    where: { userId },
    columns: { budgetUsd: true },
  });
  if (!override) return quotaOf(env) ?? null;
  if (override.budgetUsd === null) return null;
  return { budgetUsd: override.budgetUsd, window: quotaWindowOf(env) };
}

/** Sets an Admin's Quota override: a budget in dollars, or null for unlimited (spec #277). */
export async function setQuotaOverride(
  db: Database,
  userId: string,
  budgetUsd: number | null,
  now: Date,
) {
  await db
    .insert(userQuota)
    .values({ userId, budgetUsd, updatedAt: now })
    .onConflictDoUpdate({ target: userQuota.userId, set: { budgetUsd, updatedAt: now } });
}

/** Clears the override, so the user is back on the Host's default Quota (spec #277). */
export async function clearQuotaOverride(db: Database, userId: string) {
  await db.delete(userQuota).where(eq(userQuota.userId, userId));
}
