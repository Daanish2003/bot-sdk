/** How a user's Quota was changed: the Host's default, unlimited, or an amount in dollars. */
export type QuotaMode = "default" | "unlimited" | "amount";

/**
 * The one evlog event an Admin's Quota change writes (spec #277): who, what, to whom and why. The
 * reason is optional here, so an empty one is logged as null.
 */
export function quotaChangeEvent(change: {
  actor: string | undefined;
  target: string;
  mode: QuotaMode;
  budgetUsd?: number;
  reason?: string | null;
}) {
  return {
    action: "admin.user.quota",
    message: "User Quota changed by an Admin",
    actor: change.actor,
    target: change.target,
    reason: change.reason?.trim() || null,
    mode: change.mode,
    budgetUsd: change.mode === "amount" ? (change.budgetUsd ?? null) : null,
  };
}
