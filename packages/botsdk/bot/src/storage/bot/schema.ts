import type { PluginSchema } from "../plugin-schema";
import { bot } from "./bot";
import { botCheckIn, botCheckInState } from "./bot-check-in";
import {
  botDemonstration,
  botDemonstrationEvent,
  botDemonstrationEventKind,
  botDemonstrationState,
} from "./bot-demonstration";
import {
  botHelper,
  botHelperMessage,
  botHelperScreenshot,
  botHelperStatus,
  botHelperType,
} from "./bot-helper";
import { botPromptStart } from "./bot-prompt-start";
import { botReview, botReviewState, botReviewVerdict } from "./bot-review";
import { botSecret } from "./bot-secret";
import { botSummary, botSummaryKind } from "./bot-summary";
import { botRoutine, botRoutineState } from "./bot-routine";
import { botTrigger, botTriggerChannel, botTriggerSource } from "./bot-trigger";
import { botTurn, botTurnStatus } from "./bot-turn";
import { botUpload } from "./bot-upload";

export * from "./bot";
export * from "./bot-check-in";
export * from "./bot-demonstration";
export * from "./bot-helper";
export * from "./bot-prompt-start";
export * from "./bot-review";
export * from "./bot-routine";
export * from "./bot-secret";
export * from "./bot-summary";
export * from "./bot-trigger";
export * from "./bot-turn";
export * from "./bot-upload";

/** The `bot` plugin's schema module: its `bot`, `bot_turn`, `bot_prompt_start`, `bot_summary`, `bot_trigger`, `bot_routine`, `bot_check_in`, `bot_helper`, `bot_helper_message`, `bot_helper_screenshot`, `bot_review`, `secret`, `bot_demonstration`, `bot_demonstration_event` and `bot_upload` tables. */
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
    botUpload,
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
} satisfies PluginSchema;
