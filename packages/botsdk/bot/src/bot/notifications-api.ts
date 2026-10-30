import {
  defaultNotificationSettings,
  isMessagingRoute,
  type NotificationSettings,
  notificationSettingsSchema,
  pushEndpointInput,
  pushSubscriptionSchema,
  type QuietHours,
} from "@botsdk/client/bot/notifications";
import { formatterIn } from "@botsdk/client/bot/time-zone";
import { and, desc, eq, notInArray } from "drizzle-orm";

import type { BotSdkContext, Transaction } from "../plugin";
import { parseInput, rpcError, type WithUser } from "../rpc-error";
import { linkedIdentity, notificationSettings, pushSubscription } from "../storage";

/** How many devices a user's pushes reach: the ones subscribed last. */
export const maxPushDevices = 20;

/*
 * The `notifications` namespace (spec #1024): the user's Quiet hours, where Messages from Turns
 * they didn't start go, and the devices web push reaches, for all their Bots.
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

    /**
     * Replaces the user's settings, and returns them. A messaging Channel as a route is refused
     * unless the user is linked there (spec #1044).
     */
    update: async ({
      userId,
      ...rest
    }: WithUser<typeof notificationSettingsSchema>): Promise<NotificationSettings> => {
      const settings = parseInput(notificationSettingsSchema, rest);
      for (const route of new Set([settings.urgent, settings.other])) {
        if (!route || !isMessagingRoute(route)) continue;
        const [linked] = await sdk.db
          .select({ id: linkedIdentity.id })
          .from(linkedIdentity)
          .where(and(eq(linkedIdentity.userId, userId), eq(linkedIdentity.platform, route)));
        if (!linked) {
          throw rpcError(
            "BAD_REQUEST",
            "error.notificationRouteNotLinked",
            "Link your account on that Channel first",
          );
        }
      }
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

    /** The Host's VAPID public key, or `null` when the Host offers no web push. */
    pushKey: async (): Promise<string | null> => sdk.channels.pushKey(),

    /**
     * Saves a device's subscription for the user. The endpoint is the device, so one subscribed
     * before, by this user or another who used it, is replaced.
     */
    subscribe: async ({
      userId,
      ...rest
    }: WithUser<typeof pushSubscriptionSchema>): Promise<void> => {
      const { endpoint, keys } = parseInput(pushSubscriptionSchema, rest);
      const columns = { userId, p256dh: keys.p256dh, auth: keys.auth, createdAt: sdk.clock() };
      await sdk.db.transaction(async (tx) => {
        await tx
          .insert(pushSubscription)
          .values({ endpoint, ...columns })
          .onConflictDoUpdate({ target: pushSubscription.endpoint, set: columns });
        // The user's devices past the newest `maxPushDevices` are dropped, so a user can't make
        // each push fan out without end.
        const newest = tx
          .select({ endpoint: pushSubscription.endpoint })
          .from(pushSubscription)
          .where(eq(pushSubscription.userId, userId))
          .orderBy(desc(pushSubscription.createdAt), desc(pushSubscription.endpoint))
          .limit(maxPushDevices);
        await tx
          .delete(pushSubscription)
          .where(
            and(eq(pushSubscription.userId, userId), notInArray(pushSubscription.endpoint, newest)),
          );
      });
    },

    /** Removes a device's subscription, when it is the user's. */
    unsubscribe: async ({ userId, ...rest }: WithUser<typeof pushEndpointInput>): Promise<void> => {
      const { endpoint } = parseInput(pushEndpointInput, rest);
      await sdk.db
        .delete(pushSubscription)
        .where(and(eq(pushSubscription.endpoint, endpoint), eq(pushSubscription.userId, userId)));
    },
  };
}

/** The `notifications` namespace's domain methods. */
export type NotificationsApi = ReturnType<typeof notificationsApi>;
