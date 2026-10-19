import type { BotSdkPlugin } from "../../../core/server/plugin";
import { isInProcessRunner } from "../../runner/server/jobs/in-process";
import { runnerJobs } from "../../runner/server/plugin";
import { cancelUserFires } from "./routine";
// Registers the Routine fire job, which nothing else here imports.
import "./routine-fire";
import { botPluginRouter } from "./routers/index";
import { botUserDelete, exportBots } from "./store";

export type BotPlugin = BotSdkPlugin<"bot", never, never>;

/**
 * The `bot` plugin (ADR 0020): always-on Bots, each a name and a Model talking to its user in one
 * Conversation of kind `bot`.
 */
export function bot(): BotPlugin {
  return {
    id: "bot",
    requires: ["models", "runner"],
    init: (sdk) => {
      // A Turn replays from the history `chat.job` holds. Trigger.dev records nothing and its retry
      // starts over, which would send the Messages again (ADR 0011, the #482 amendment).
      if (!isInProcessRunner(runnerJobs(sdk))) {
        throw new Error(
          "The bot plugin needs the in-process runner: a Trigger.dev retry starts a Turn over and would send its Messages again",
        );
      }
    },
    router: botPluginRouter,
    deleteUser: {
      // No Routine fires for a deleted user: its queued fires go with the rows.
      before: async (sdk, args) => {
        await cancelUserFires(sdk, args.tx, args.userId);
        return botUserDelete.before(sdk, args);
      },
      after: botUserDelete.after,
    },
    exportUser: (_sdk, userId, tx) => exportBots(tx, userId),
  };
}
