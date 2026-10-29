import { z } from "zod";

/**
 * Where a Message from a Turn the user didn't start goes (spec #1024): `in_app` only, or by `email`
 * too. Every Message is in the Conversation whatever the choice.
 */
export const notificationRoutes = ["in_app", "email"] as const;

export type NotificationRoute = (typeof notificationRoutes)[number];

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
 * `urgent` is where urgent Messages go and `other` where the rest go; null is the default, the
 * Channel the user last wrote from.
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
