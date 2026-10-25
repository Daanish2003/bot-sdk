import type { PluginSchema } from "../../../core/server/db/plugin-schema";
import { channelEmailAddress } from "./db/channel-email-address";

export * from "./db/channel-email-address";

/** The `channel` plugin's schema module: its `channel_email_address` table. */
export const channelSchema = {
  tables: { channelEmailAddress },
  enums: {},
} satisfies PluginSchema;
