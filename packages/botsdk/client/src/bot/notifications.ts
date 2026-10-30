import { z } from "zod";

/**
 * The messaging Channels a route can name (spec #1044): the platform's id, such as `telegram`. A
 * route needs the user's Linked identity there and an active Channel account on the Bot.
 */
export const messagingRoutes = ["telegram"] as const;

/**
 * Where a Message from a Turn the user didn't start goes (spec #1024): `in_app` only, or by `email`,
 * web `push` or a linked messaging Channel too. Every Message is in the Conversation whatever the
 * choice.
 */
export const notificationRoutes = ["in_app", "email", "push", ...messagingRoutes] as const;

export type NotificationRoute = (typeof notificationRoutes)[number];

/** Whether `route` names a messaging Channel (a platform id) rather than the app, email or push. */
export const isMessagingRoute = (route: string): route is (typeof messagingRoutes)[number] =>
  (messagingRoutes as readonly string[]).includes(route);

/** A time of day, `HH:MM` on the 24-hour clock. */
export const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time is HH:MM on the 24-hour clock, like "22:00"');

/**
 * Quiet hours (spec #1024): from `start` to `end` in the user's time zone, through midnight when
 * `end` comes first. The two differ.
 */
export const quietHoursSchema = z
  .object({ start: clockTimeSchema, end: clockTimeSchema })
  .refine(({ start, end }) => start !== end, { error: "Quiet hours start and end differ" });

export type QuietHours = z.infer<typeof quietHoursSchema>;

/**
 * The user's notification settings, for all their Bots (spec #1024). `quietHours` null is off.
 * `urgent` is where urgent Messages go and `other` where the rest go; null is the default: for
 * urgent Messages, web push when the user has a subscribed device, and otherwise (and for the
 * rest) the Channel the user last wrote from.
 */
export const notificationSettingsSchema = z.object({
  quietHours: quietHoursSchema.nullable(),
  urgent: z.enum(notificationRoutes).nullable(),
  other: z.enum(notificationRoutes).nullable(),
});

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/** A user who has set nothing: delivery is as before the settings existed. */
export const defaultNotificationSettings: NotificationSettings = {
  quietHours: null,
  urgent: null,
  other: null,
};

/** How many bytes a base64url string holds, its padding left out. */
const byteLengthOf = (base64url: string) =>
  Math.floor((base64url.replace(/=+$/, "").length * 3) / 4);

/** A base64url key of a push subscription, of `bytes` bytes (or at least `bytes`, with `orMore`). */
const pushKeySchema = (bytes: number, orMore = false) =>
  z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+=*$/, "A push key is base64url")
    .refine((key) => (orMore ? byteLengthOf(key) >= bytes : byteLengthOf(key) === bytes), {
      error: `A push key is ${orMore ? "at least " : ""}${bytes} bytes`,
    });

/** A push service's endpoint: HTTPS, as every browser's push service is. */
const pushEndpointSchema = z.url({ protocol: /^https$/ }).max(2048);

/**
 * One device's web push subscription (spec #1024), as the browser's `PushSubscription.toJSON()`
 * gives it.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
  // The device's uncompressed P-256 public key, and its auth secret (RFC 8291).
  keys: z.object({ p256dh: pushKeySchema(65), auth: pushKeySchema(16, true) }),
});

/** A device's subscription, named by its endpoint. */
export const pushEndpointInput = z.object({ endpoint: pushEndpointSchema });
