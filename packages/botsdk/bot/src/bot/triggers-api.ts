import { triggerInput } from "@botsdk/client/bot/contract";

import type { BotSdkContext } from "../plugin";
import { parseInput, type WithUser } from "../rpc-error";
import { skipTrigger } from "./triggers";

/** The `triggers` namespace's domain methods (spec #1007), taking the user's id as `bots` does. */
export function triggersApi(sdk: BotSdkContext) {
  return {
    /**
     * Skips one waiting Routine or Check-in Trigger: no Turn takes it, and it shows in Done as
     * skipped. A user's or Helper's Trigger, or one a Turn took, is refused. Another user's is not
     * found.
     */
    skip: async ({ userId, ...rest }: WithUser<typeof triggerInput>) =>
      skipTrigger(sdk, userId, parseInput(triggerInput, rest).triggerId),
  };
}

/** The `triggers` namespace's domain methods. */
export type TriggersApi = ReturnType<typeof triggersApi>;
