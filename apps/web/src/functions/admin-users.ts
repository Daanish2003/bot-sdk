import { account, user } from "@ai-chat/db/schema/auth";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { isBanActive } from "@/admin/ban";
import { type AdminUser, selectUsers, windowStart } from "@/admin/users";
import { ENV } from "@/env.server";
import { quotaOf } from "@/host-models";
import { adminMiddleware } from "@/middleware/admin";
import { db, sdk } from "@/services";

const querySchema = z.object({
  search: z.string().optional(),
  sort: z.enum(["email", "spend"]).default("email"),
  atQuota: z.boolean().default(false),
});

const providerNames: Record<string, string> = {
  credential: "Password",
  github: "GitHub",
  google: "Google",
};

/**
 * The Admin users table (spec #277): every user with their sign-in methods, role, Ban status and
 * this window's spend against their Quota. Never Conversation content. Admin only (404 otherwise).
 */
export const listAdminUsers = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .inputValidator((input: unknown) => querySchema.parse(input ?? {}))
  .handler(async ({ data }): Promise<AdminUser[]> => {
    const [users, accounts] = await Promise.all([
      db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          banned: user.banned,
          banExpires: user.banExpires,
          twoFactorEnabled: user.twoFactorEnabled,
          createdAt: user.createdAt,
        })
        .from(user),
      db.select({ userId: account.userId, providerId: account.providerId }).from(account),
    ]);

    // The Quota window is the Host's (`HOST_QUOTA_WINDOW`), so spend is summed over the same one.
    const now = new Date();
    const window = quotaOf(ENV)?.window ?? "day";
    const [totals, quotas] = await Promise.all([
      sdk.plugin("models").usageTotals({ since: windowStart(window, now), until: now }),
      Promise.all(users.map((row) => sdk.plugin("models").quota(row.id))),
    ]);
    const spentBy = new Map(totals.map((total) => [total.userId, total.costMicros]));

    const rows: AdminUser[] = users.map((row, index) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      createdAt: row.createdAt.toISOString(),
      signInMethods: accounts
        .filter((linked) => linked.userId === row.id)
        .map((linked) => providerNames[linked.providerId] ?? linked.providerId),
      role: row.role,
      banned: isBanActive(row, now),
      banExpires: isBanActive(row, now) ? (row.banExpires?.toISOString() ?? null) : null,
      twoFactorEnabled: row.twoFactorEnabled === true,
      spentMicros: spentBy.get(row.id) ?? 0,
      budgetMicros: quotas[index]?.budgetMicros ?? null,
    }));
    return selectUsers(rows, data);
  });
