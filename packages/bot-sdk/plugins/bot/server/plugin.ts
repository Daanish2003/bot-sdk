import type { BotSdkPlugin } from "../../../core/server/plugin";
import { isInProcessRunner } from "../../runner/server/jobs/in-process";
import { runnerJobs } from "../../runner/server/plugin";
import { cancelUserCheckIns } from "./check-in";
import { cancelUserHelpers, hasRunningHelper } from "./helper";
import { cancelUserFires } from "./routine";
import { startRoutineReconcile } from "./routine-fire";
import "./check-in-fire";
import { handleRoutineWebhook } from "./routine-webhook";
import { botPluginRouter } from "./routers/index";
import { botUserDelete, exportBots, hasTurnUsingComputer, userHasBot } from "./store";
import { stopUserTurns } from "./turn";

export type BotPlugin = BotSdkPlugin<"bot", never, never>;

/** What the `bot` plugin gives the Host (`sdk.plugin("bot")`). */
export type BotApi = {
  /**
   * The inbound webhook handler of webhook Routines (ADR 0021), Request → Response. The Host mounts
   * it at `/api/routines/webhook/<token>` with no sign-in: the token is the authentication.
   */
  webhookHandler: (request: Request) => Promise<Response>;
  /** Stops the running Turn of each of the user's Bots. The Host calls it when it Bans the user. */
  stopTurns: (userId: string) => Promise<void>;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    bot: BotApi;
  }
}

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
      if (sdk.hasPlugin("computer")) {
        const computer = sdk.plugin("computer");
        // Never mid-Turn (#508): a Turn that started before the Computer's last activity holds it.
        computer.addBusyCheck((userId, lastActiveAt) =>
          hasTurnUsingComputer(sdk.db, userId, lastActiveAt),
        );
        // A running Helper may use it at any moment; a waiting one doesn't hold it.
        computer.addBusyCheck((userId) => hasRunningHelper(sdk.db, userId));
        // Only a user with a Bot gets a Computer, so a Turn racing the user's delete creates none.
        computer.addOwnerCheck(userHasBot);
      }
      const api: BotApi = {
        webhookHandler: (request) => handleRoutineWebhook(sdk, request),
        stopTurns: (userId) => stopUserTurns(sdk, userId),
      };
      return { api };
    },
    // Repairs a Routine whose chain of fires broke, now and then hourly (#578).
    start: startRoutineReconcile,
    router: botPluginRouter,
    deleteUser: {
      // No Routine, Check-in or Helper runs for a deleted user: its jobs are cancelled.
      before: async (sdk, args) => {
        await cancelUserFires(sdk, args.tx, args.userId);
        await cancelUserCheckIns(sdk, args.tx, args.userId);
        await cancelUserHelpers(sdk, args.tx, args.userId);
        return botUserDelete.before(sdk, args);
      },
      after: botUserDelete.after,
    },
    exportUser: (_sdk, userId, tx) => exportBots(tx, userId),
  };
}
