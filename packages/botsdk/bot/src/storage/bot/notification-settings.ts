import { notificationRoutes } from "@botsdk/client/bot/notifications";
import { text, timestamp } from "drizzle-orm/pg-core";

import { botsdkSchema } from "../botsdk-schema";

/** Where a Message from a Turn the user didn't start goes (spec #1024). */
export const notificationRoute = botsdkSchema.enum("notification_route", notificationRoutes);

/**
 * A user's notification settings (spec #1024), for all their Bots. A user with no row has set
 * nothing, which is every column null.
 */
export const notificationSettings = botsdkSchema.table("notification_settings", {
  /** The Host's user id, with no foreign key, as everywhere in the `botsdk` schema. */
  userId: text("user_id").primaryKey(),
  /** Quiet hours' start and end, `HH:MM` in the user's time zone; both null is off. */
  quietStart: text("quiet_start"),
  quietEnd: text("quiet_end"),
  /** Where urgent Messages go; null is the default. */
  urgentRoute: notificationRoute("urgent_route"),
  /** Where the rest go; null is the default. */
  otherRoute: notificationRoute("other_route"),
  updatedAt: timestamp("updated_at").notNull(),
});
