import type { CoreTableName, PluginSchema } from "../../../core/server/db/plugin-schema";
import { channelEmailAddress } from "./db/channel-email-address";

export * from "./db/channel-email-address";

/** The `channel` plugin's schema module: its `channel_email_address` table. It adds no fields to core tables. */
export const channelSchema = {
  tables: { channelEmailAddress },
  enums: {},
  // Kept empty by type: core/server/db/schema.ts spreads no channel columns.
  fields: {} satisfies Partial<Record<CoreTableName, never>>,
} satisfies PluginSchema;
