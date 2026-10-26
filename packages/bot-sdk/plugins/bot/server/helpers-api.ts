import type { BotSdkContext } from "../../../core/server/plugin";
import { parseInput, type WithUser } from "../../../core/server/rpc-error";
import { helperDone, listHelpers, stopBotHelpers } from "./helpers";
import { requireOwnedBot } from "./owned-bot";
import { helperListInput, helperDoneInput, helperStopInput } from "../shared/contract";

/*
 * The `helpers` namespace's domain methods (spec #873), taking the user's id as `bots` does.
 */

/** The `helpers` namespace over the core context. */
export function helpersApi(sdk: BotSdkContext) {
  return {
    /** One of the user's Bots' Helpers, oldest first, each with the Message its card follows. */
    list: async ({ userId, ...rest }: WithUser<typeof helperListInput>) => {
      const { botId } = parseInput(helperListInput, rest);
      await requireOwnedBot(sdk.db, userId, botId);
      return listHelpers(sdk.db, botId);
    },

    /**
     * The user's Done on a Helper waiting for them at a hand-off (#568): it goes back to running and
     * a fresh job carries on from where it stopped, and its Computer card reads done. Refused,
     * "This task was stopped.", once it isn't waiting. Another user's Helper is not found.
     */
    done: async ({ userId, ...rest }: WithUser<typeof helperDoneInput>) =>
      helperDone(sdk, userId, parseInput(helperDoneInput, rest).helperId),

    /**
     * Stops one of the user's Bot's Helpers, or all of its live ones with no `helperId`, as
     * `stop_helpers` does: no `helper` Trigger. One that already ended, or isn't the Bot's, stays
     * as it is. Another user's Bot is not found.
     */
    stop: async ({ userId, ...rest }: WithUser<typeof helperStopInput>): Promise<void> => {
      const { botId, helperId } = parseInput(helperStopInput, rest);
      await requireOwnedBot(sdk.db, userId, botId);
      await stopBotHelpers(sdk, botId, helperId);
    },
  };
}

/** The `helpers` namespace's domain methods. */
export type HelpersApi = ReturnType<typeof helpersApi>;
