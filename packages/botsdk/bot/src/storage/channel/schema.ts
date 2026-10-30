import type { PluginSchema } from "../plugin-schema";
import { channelAccount, channelAccountStatus } from "./channel-account";
import { channelEmailAddress } from "./channel-email-address";

export * from "./channel-account";
export * from "./channel-email-address";

/** The `channel` plugin's schema module: its `channel_email_address` and `channel_account` tables. */
export const channelSchema = {
  tables: { channelEmailAddress, channelAccount },
  enums: { channelAccountStatus },
} satisfies PluginSchema;
