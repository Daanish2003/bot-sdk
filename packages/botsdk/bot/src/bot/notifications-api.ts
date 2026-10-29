import {
  defaultNotificationSettings,
  type NotificationSettings,
  notificationSettingsSchema,
  type QuietHours,
} from "@botsdk/client/bot/notifications";
import { formatterIn } from "@botsdk/client/bot/time-zone";
import { eq } from "drizzle-orm";

import type { BotSdkContext, Transaction } from "../plugin";
import { parseInput, type WithUser } from "../rpc-error";
import { notificationSettings } from "../storage";

/*
 * The `notifications` namespace (spec #1024): the user's Quiet hours and where Messages from Turns
 * they didn't start go, for all their Bots.
 */

/** The user's notification settings; the defaults when they have no row. */
export async function notificationSettingsOf(
  db: BotSdkContext["db"] | Transaction,
  userId: string,
): Promise<NotificationSettings> {
  const [row] = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.userId, userId));
  if (!row) return defaultNotificationSettings;
  return {
    quietHours:
      row.quietStart && row.quietEnd ? { start: row.quietStart, end: row.quietEnd } : null,
    urgent: row.urgentRoute,
    other: row.otherRoute,
  };
}

const clockTime: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * Whether `at` falls in `quietHours` as the clock reads in `zone`: from the start, up to but not
 * including the end, through midnight when the end comes first.
 */
export function inQuietHours(quietHours: QuietHours | null, at: Date, zone: string): boolean {
  if (!quietHours) return false;
  const now = formatterIn(zone, clockTime).format(at);
  const { start, end } = quietHours;
  return start < end ? start <= now && now < end : now >= start || now < end;
}

/** The `notifications` namespace over the core context. */
export function notificationsApi(sdk: BotSdkContext) {
  return {
    /** The user's settings; the defaults when they have set nothing. */
    get: async ({ userId }: { userId: string }) => notificationSettingsOf(sdk.db, userId),

    /** Replaces the user's settings, and returns them. */
    update: async ({
      userId,
      ...rest
    }: WithUser<typeof notificationSettingsSchema>): Promise<NotificationSettings> => {
      const settings = parseInput(notificationSettingsSchema, rest);
      const columns = {
        quietStart: settings.quietHours?.start ?? null,
        quietEnd: settings.quietHours?.end ?? null,
        urgentRoute: settings.urgent,
        otherRoute: settings.other,
        updatedAt: sdk.clock(),
      };
      await sdk.db
        .insert(notificationSettings)
        .values({ userId, ...columns })
        .onConflictDoUpdate({ target: notificationSettings.userId, set: columns });
      return settings;
    },
  };
}

/** The `notifications` namespace's domain methods. */
export type NotificationsApi = ReturnType<typeof notificationsApi>;
