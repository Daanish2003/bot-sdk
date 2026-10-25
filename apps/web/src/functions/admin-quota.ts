import { createServerFn } from "@tanstack/react-start";
import { log } from "evlog";
import { z } from "zod";

import { quotaChangeEvent } from "@/admin/audit";
import { clearQuotaOverride, setQuotaOverride } from "@/admin/quota";
import { lastDays, spendByDay, spendRange, type DaySpend } from "@/admin/spend";
import { ENV } from "@/env.server";
import { quotaOf, quotaWindowOf } from "@/host-models";
import { adminMiddleware } from "@/middleware/admin";
import { db, sdk } from "@/services";

/** A user's Quota as the detail page shows it: an Admin's override, or the Host's default. */
export type AdminQuota = {
  mode: "default" | "unlimited" | "amount";
  /** The override's budget in dollars, when the mode is `amount`. */
  budgetUsd: number | null;
  /** The Host's default budget in dollars, or `null` when the Host's Quota is unlimited. */
  defaultBudgetUsd: number | null;
  window: "day" | "month";
};

export type AdminUserDetail = {
  id: string;
  name: string;
  email: string;
  quota: AdminQuota;
  /** Whether two-factor sign-in is on, so the detail page shows the turn-off control (#332). */
  twoFactorEnabled: boolean;
  /** The last 30 UTC days, oldest first, with the spend split by Model. */
  days: DaySpend[];
  models: string[];
};

const userInput = z.object({ userId: z.string().min(1) });

const quotaInput = z
  .object({
    userId: z.string().min(1),
    mode: z.enum(["default", "unlimited", "amount"]),
    /** Dollars, for mode `amount`. 0 turns Host Models off for the user. */
    budgetUsd: z.number().finite().nonnegative().optional(),
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .refine((input) => input.mode !== "amount" || input.budgetUsd !== undefined, {
    message: "Enter a budget in dollars",
  });

/**
 * One user's detail for the Admin (spec #277): their Quota and spend per day over the last 30 UTC
 * days, split by Model. Never Conversation content. Admin only (404 otherwise).
 */
export const getAdminUserDetail = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .validator((input: unknown) => userInput.parse(input))
  .handler(async ({ data }): Promise<AdminUserDetail> => {
    const target = await db.query.user.findFirst({
      where: { id: data.userId },
      columns: { id: true, name: true, email: true, twoFactorEnabled: true },
    });
    if (!target) throw new Error("No user has that id");

    const now = new Date();
    const [override, usage] = await Promise.all([
      db.query.userQuota.findFirst({
        where: { userId: data.userId },
        columns: { budgetUsd: true },
      }),
      sdk.plugin("models").usage({ userId: data.userId, ...spendRange(now) }),
    ]);
    const days = spendByDay(usage, lastDays(now, 30));
    const models = [...new Set(usage.map((row) => row.model))].sort();

    return {
      id: target.id,
      name: target.name,
      email: target.email,
      twoFactorEnabled: target.twoFactorEnabled === true,
      quota: {
        mode: override ? (override.budgetUsd === null ? "unlimited" : "amount") : "default",
        budgetUsd: override?.budgetUsd ?? null,
        defaultBudgetUsd: quotaOf(ENV)?.budgetUsd ?? null,
        window: quotaWindowOf(ENV),
      },
      days,
      models,
    };
  });

/**
 * Changes a user's Quota (spec #277): an amount in dollars, unlimited, or back to the Host's
 * default. Writes one evlog event for the change.
 */
export const setUserQuota = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .validator((input: unknown) => quotaInput.parse(input))
  .handler(async ({ data, context }) => {
    const target = await db.query.user.findFirst({
      where: { id: data.userId },
      columns: { id: true },
    });
    if (!target) throw new Error("No user has that id");

    if (data.mode === "default") {
      await clearQuotaOverride(db, data.userId);
    } else {
      await setQuotaOverride(
        db,
        data.userId,
        data.mode === "amount" ? (data.budgetUsd ?? null) : null,
        new Date(),
      );
    }
    log.info(
      quotaChangeEvent({
        actor: context.session?.user.id,
        target: data.userId,
        mode: data.mode,
        budgetUsd: data.budgetUsd,
        reason: data.reason,
      }),
    );
  });
