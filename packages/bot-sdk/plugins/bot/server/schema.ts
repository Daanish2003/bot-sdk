import type { CoreTableName, PluginSchema } from "../../../core/server/db/plugin-schema";
import { bot } from "./db/bot";
import { botTrigger, botTriggerChannel, botTriggerSource } from "./db/bot-trigger";
import { botTurn, botTurnStatus } from "./db/bot-turn";

export * from "./db/bot";
export * from "./db/bot-trigger";
export * from "./db/bot-turn";

/** The `bot` plugin's schema module: its `bot`, `bot_turn` and `bot_trigger` tables. It adds no fields to core tables. */
export const botSchema = {
  tables: { bot, botTurn, botTrigger },
  enums: { botTurnStatus, botTriggerSource, botTriggerChannel },
  // Kept empty by type: core/server/db/schema.ts spreads no bot columns, so adding some means adding the spread there.
  fields: {} satisfies Partial<Record<CoreTableName, never>>,
} satisfies PluginSchema;
