import { z } from "zod";

/** Whether a Channel account listens, or the platform rejected its credentials (spec #1044). */
export const channelAccountStatuses = ["active", "needs_attention"] as const;

export type ChannelAccountStatus = (typeof channelAccountStatuses)[number];

/** A messaging platform's id, such as `telegram`: the messaging adapter's `id`. */
export const platformSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_-]*$/, "A platform is a messaging adapter's id, like telegram");

/** The Bot and a platform it may have a Channel account on. */
export const channelAccountInput = z.object({ botId: z.uuid(), platform: platformSchema });

/**
 * Adds the Bot's Channel account on `platform`, or fixes it with new credentials: one value per
 * field the platform takes (Telegram: `token`). The credentials are checked with the platform first.
 */
export const saveChannelAccountInput = channelAccountInput.extend({
  credentials: z.record(z.string().max(100), z.string().trim().min(1).max(4096)),
});

/**
 * One messaging platform the Host offers, and the Bot's Channel account there, if any. Its
 * credentials never come back.
 */
export type ChannelAccountRow = {
  platform: string;
  /** The credentials an account on the platform takes, by field name. */
  fields: string[];
  account: {
    /** The platform bot's display handle, such as `@ada_bot`. */
    handle: string;
    status: ChannelAccountStatus;
    /** Why the platform rejected the credentials, while the status is `needs_attention`. */
    reason: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
};
