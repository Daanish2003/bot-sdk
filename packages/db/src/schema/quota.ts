import { doublePrecision, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth";

/**
 * A user's own Quota on the Host's Models, set by an Admin (spec #277). A `budgetUsd` of null is
 * unlimited, 0 turns Host Models off, and no row means the Host's default Quota (`HOST_QUOTA_*`).
 */
export const userQuota = pgTable("user_quota", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  budgetUsd: doublePrecision("budget_usd"),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});
