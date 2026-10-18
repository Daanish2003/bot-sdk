import type { BotSdkPlugin } from "../../../core/server/plugin";
import { isInProcessRunner } from "../../runner/server/jobs/in-process";
import { runnerJobs } from "../../runner/server/plugin";
import { botPluginRouter } from "./routers/index";
import { botUserDelete, exportBots, hasTurnUsingComputer } from "./store";

export type BotPlugin = BotSdkPlugin<"bot", never, never>;

/**
 * The `bot` plugin (ADR 0020): always-on Bots, each a name and a Model talking to its user in one
 * Conversation of kind `bot`.
 */
export function bot(): BotPlugin {
  return {
    id: "bot",
    requires: ["models", "runner"],
    // Softly: with computer on, a Turn has its tools, and a running Turn keeps the Computer awake.
    uses: ["computer"],
    init: (sdk) => {
      // A Turn replays from the history `chat.job` holds. Trigger.dev records nothing and its retry
      // starts over, which would send the Messages again (ADR 0011, the #482 amendment).
      if (!isInProcessRunner(runnerJobs(sdk))) {
        throw new Error(
          "The bot plugin needs the in-process runner: a Trigger.dev retry starts a Turn over and would send its Messages again",
        );
      }
      // Never mid-Turn (#508): a Turn that started before the Computer's last activity holds it.
      if (sdk.hasPlugin("computer")) {
        sdk
          .plugin("computer")
          .addBusyCheck((userId, lastActiveAt) =>
            hasTurnUsingComputer(sdk.db, userId, lastActiveAt),
          );
      }
    },
    router: botPluginRouter,
    deleteUser: botUserDelete,
    exportUser: (_sdk, userId, tx) => exportBots(tx, userId),
  };
}
