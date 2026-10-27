import { screensPath, screenViewPath } from "@botsdk/client/bot/helper";

import { deleteBlobsBestEffort } from "../../../core/server/storage";
import type { BotSdkPlugin, Route } from "../../../core/server/plugin";

import {
  cancelUserCheckIns,
  cancelUserFires,
  startRoutineReconcile,
  handleRoutineWebhook,
  routineJobs,
} from "./routines";
import {
  deliveryJob,
  deleteUserUploads,
  sentFileResponse,
  screenshotsConversationDelete,
  botUserDelete,
  exportBots,
  hasTurnUsingComputer,
  newestBotModel,
  userHasBot,
} from "./conversation";

import {
  botHelperJob,
  cancelUserHelpers,
  helperStoppedJob,
  hasLiveDemonstration,
  hasRunningHelper,
  handleScreenRequest,
  stopUserHelpers,
} from "./helpers";

import { stopUserTurns, turnJobs } from "./turn";
import { demonstrationJobs, stopUserDemonstrations } from "./demonstrations";

import { botPluginRouter } from "./routers";
import { botsApi, type BotsApi } from "./bots-api";
import { conversationsApi } from "./conversations-api";
import { screensApi } from "./screens-api";
import { secretsApi } from "./secrets-api";
import { checkInsApi, routinesApi } from "./routines-api";
import { demonstrationsApi } from "./demonstrations-api";
import { helpersApi } from "./helpers-api";
import { reviewsApi } from "./reviews-api";
import { rotateSecretKeys } from "./safety";

export type BotPlugin = BotSdkPlugin<"bot", never, never>;

/** The Bots' jobs (spec #872): the factory lists them on every instance, with the core context. */
export const botJobs = [
  ...turnJobs,
  ...routineJobs,
  ...demonstrationJobs,
  botHelperJob,
  helperStoppedJob,
  deliveryJob,
];

/**
 * The core's Bots, as the Host reaches them (`sdk.bots`, spec #871): the domain methods (spec #873)
 * and the Ban's stop. The webhook and the live view are served by the HTTP layer.
 */
export type BotApi = BotsApi & {
  /**
   * Stops the running Turn and the running and waiting Helpers of each of the user's Bots, closing
   * their Screens. The Host calls it when it Bans the user.
   */
  stopTurns: (input: { userId: string }) => Promise<void>;
  /** The Model that reviews the Bots' risky tool calls, as the `reviewModel` option named it, if any. */
  reviewModel: string | undefined;
};

/** How the core sets up its Bots, from the factory's options. */
export type BotOptions = {
  /** The factory's `reviewModel` option: the Model that Auto-reviews the Bots' risky tool calls. */
  reviewModel?: string;
};

/**
 * The core's Bots (spec #871): always-on Bots, each a name and a Model talking to its user in one
 * Conversation of kind `bot`. Its `init` sets `sdk.bots`; the slots always enable it.
 */
export function bot({ reviewModel }: BotOptions = {}): BotPlugin {
  return {
    id: "bot",
    init: (sdk) => {
      // With a Computer, a Turn has its tools, and a running Turn keeps the Computer awake.
      const { computer } = sdk;
      if (computer) {
        // Never mid-Turn (#508): a Turn that started before the Computer's last activity holds it.
        computer.addBusyCheck((userId, lastActiveAt) =>
          hasTurnUsingComputer(sdk.db, userId, lastActiveAt),
        );
        // A running Helper may use it at any moment; a waiting one doesn't hold it.
        computer.addBusyCheck((userId) => hasRunningHelper(sdk.db, userId));
        // The user drives a Screen while a Demonstration records or is paused (spec #713).
        computer.addBusyCheck((userId) => hasLiveDemonstration(sdk.db, { userId }));
        // Only a user with a Bot gets a Computer, so a Turn racing the user's delete creates none.
        computer.addOwnerCheck(userHasBot);
      }
      // The default Model of the user's pickers is the newest Bot's.
      sdk.models.addRecentModelSource((userId) => newestBotModel(sdk.db, userId));
      const api: BotApi = {
        ...botsApi(sdk),
        stopTurns: async ({ userId }) => {
          // The Turns first, so none starts a Helper after its Helpers are stopped.
          await stopUserTurns(sdk, userId);
          await stopUserHelpers(sdk, userId);
          await stopUserDemonstrations(sdk, userId);
        },
        reviewModel,
      };
      sdk.bots = api;
      sdk.conversations = conversationsApi(sdk);
      sdk.secrets = secretsApi(sdk);
      sdk.screens = screensApi(sdk);
      sdk.routines = routinesApi(sdk);
      sdk.checkIns = checkInsApi(sdk);
      sdk.helpers = helpersApi(sdk);
      sdk.demonstrations = demonstrationsApi(sdk);
      sdk.reviews = reviewsApi(sdk);
    },
    // Repairs a Routine whose chain of fires broke, now and then hourly (#578).
    start: startRoutineReconcile,
    router: botPluginRouter,
    routes: [
      {
        // A file the Bot sent, as a download.
        method: "GET",
        path: "/bot-files/:id",
        handle: (_request, { user, sdk, params }) => sentFileResponse(sdk, user.id, params.id!),
      },
      {
        // The same file for display, an image only.
        method: "GET",
        path: "/bot-files/:id/inline",
        handle: (_request, { user, sdk, params }) =>
          sentFileResponse(sdk, user.id, params.id!, { inline: true }),
      },
      {
        // A webhook Routine's URL (ADR 0021): no sign-in, the token is the authentication.
        method: "POST",
        path: "/routines/webhook/:token",
        public: true,
        handle: (request, { sdk, params }) => handleRoutineWebhook(sdk, request, params.token!),
      },
      // The live view's noVNC page and files (#597), fetched from the Screen with the traffic token
      // added server-side. No sign-in: the view token in the path is the authentication, and a
      // request without a valid one answers 403. Its socket is `createScreenSocket`'s hooks.
      ...(["GET", "HEAD"] as const).map((method): Route => ({
        method,
        path: `${screenViewPath}/*`,
        public: true,
        handle: (request, { sdk, basePath }) =>
          handleScreenRequest(sdk, request, screensPath(basePath)),
      })),
    ],
    deleteUser: {
      // No Routine, Check-in or Helper runs for a deleted user: its jobs are cancelled.
      before: async (sdk, args) => {
        await cancelUserFires(sdk, args.tx, args.userId);
        await cancelUserCheckIns(sdk, args.tx, args.userId);
        await cancelUserHelpers(sdk, args.tx, args.userId);
        // The files they uploaded and never sent go too (spec #801), their bytes after the commit.
        const uploadKeys = await deleteUserUploads(args.tx, args.userId);
        const afterCommit = await botUserDelete.before(sdk, args);
        return async () => {
          await afterCommit();
          await deleteBlobsBestEffort(sdk, uploadKeys);
        };
      },
      after: botUserDelete.after,
    },
    exportUser: (_sdk, userId, tx) => exportBots(tx, userId),
    // The user's Secrets are encrypted under the keyring too (ADR 0010).
    rotateKeys: rotateSecretKeys,
    // A Bot's Helpers' screenshots go with its Conversation (#608).
    databaseHooks: { conversation: { delete: screenshotsConversationDelete } },
  };
}
