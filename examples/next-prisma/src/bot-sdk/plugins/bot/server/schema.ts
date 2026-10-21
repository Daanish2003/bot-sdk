import type { CoreTableName, PluginSchema } from "../../../core/server/db/plugin-schema";
import { bot } from "./db/bot";
import { botCheckIn, botCheckInState } from "./db/bot-check-in";
import {
  botDemonstration,
  botDemonstrationEvent,
  botDemonstrationEventKind,
  botDemonstrationState,
} from "./db/bot-demonstration";
import {
  botHelper,
  botHelperMessage,
  botHelperScreenshot,
  botHelperStatus,
  botHelperType,
} from "./db/bot-helper";
import { botPromptStart } from "./db/bot-prompt-start";
import { botReview, botReviewState, botReviewVerdict } from "./db/bot-review";
import { botSecret } from "./db/bot-secret";
import { botSummary, botSummaryKind } from "./db/bot-summary";
import { botRoutine, botRoutineState } from "./db/bot-routine";
import { botTrigger, botTriggerChannel, botTriggerSource } from "./db/bot-trigger";
import { botTurn, botTurnStatus } from "./db/bot-turn";

export * from "./db/bot";
export * from "./db/bot-check-in";
export * from "./db/bot-demonstration";
export * from "./db/bot-helper";
export * from "./db/bot-prompt-start";
export * from "./db/bot-review";
export * from "./db/bot-routine";
export * from "./db/bot-secret";
export * from "./db/bot-summary";
export * from "./db/bot-trigger";
export * from "./db/bot-turn";

/** The `bot` plugin's schema module: its `bot`, `bot_turn`, `bot_prompt_start`, `bot_summary`, `bot_trigger`, `bot_routine`, `bot_check_in`, `bot_helper`, `bot_helper_message`, `bot_helper_screenshot`, `bot_review`, `secret`, `bot_demonstration` and `bot_demonstration_event` tables. It adds no fields to core tables. */
export const botSchema = {
  tables: {
    bot,
    botTurn,
    botPromptStart,
    botSummary,
    botTrigger,
    botRoutine,
    botCheckIn,
    botHelper,
    botHelperMessage,
    botHelperScreenshot,
    botReview,
    botSecret,
    botDemonstration,
    botDemonstrationEvent,
  },
  enums: {
    botTurnStatus,
    botTriggerSource,
    botTriggerChannel,
    botRoutineState,
    botCheckInState,
    botHelperType,
    botHelperStatus,
    botSummaryKind,
    botReviewVerdict,
    botReviewState,
    botDemonstrationState,
    botDemonstrationEventKind,
  },
  // Kept empty by type: core/server/db/schema.ts spreads no bot columns, so adding some means adding the spread there.
  fields: {} satisfies Partial<Record<CoreTableName, never>>,
} satisfies PluginSchema;
