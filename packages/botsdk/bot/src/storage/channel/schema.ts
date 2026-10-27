import type { PluginSchema } from "../plugin-schema";
import { channelEmailAddress } from "./channel-email-address";

export * from "./channel-email-address";

/** The `channel` plugin's schema module: its `channel_email_address` table. */
export const channelSchema = {
  tables: { channelEmailAddress },
  enums: {},
} satisfies PluginSchema;
