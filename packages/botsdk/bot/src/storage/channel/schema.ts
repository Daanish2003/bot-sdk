import type { PluginSchema } from "../plugin-schema";
import { channelAccount, channelAccountStatus } from "./channel-account";
import { channelEmailAddress } from "./channel-email-address";
import { linkCode, linkedIdentity } from "./linked-identity";

export * from "./channel-account";
export * from "./channel-email-address";
export * from "./linked-identity";

/** The `channel` plugin's schema module: its `channel_email_address`, `channel_account`, `linked_identity` and `link_code` tables. */
export const channelSchema = {
  tables: { channelEmailAddress, channelAccount, linkedIdentity, linkCode },
  enums: { channelAccountStatus },
} satisfies PluginSchema;
