import { index, text, timestamp } from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";

/**
 * One device's web push subscription (spec #1024), for all the user's Bots. A device subscribed
 * again, by any user, replaces its row: the endpoint is the device.
 */
export const pushSubscription = botsdkSchema.table(
  "push_subscription",
  {
    /** The push service's endpoint for this device. */
    endpoint: text("endpoint").primaryKey(),
    /** The Host's user id, with no foreign key, as everywhere in the `botsdk` schema. */
    userId: text("user_id").notNull(),
    /** The device's P-256 public key and auth secret, base64url. */
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("push_subscription_user_id_idx").on(table.userId)],
);
