import { demonstrationInput } from "@botsdk/client/bot/contract";
import type { DemonstrationAction } from "@botsdk/client/bot/demonstration";

import type { BotSdkContext } from "../../../core/server/plugin";
import { parseInput, type WithUser } from "../../../core/server/rpc-error";
import { actOnDemonstration, demonstrationSteps } from "./demonstrations";
import { screenView } from "./helpers";

/*
 * The `demonstrations` namespace's domain methods (spec #873): the user's side of a Demonstration
 * (spec #713), taking the user's id as `bots` does. Each acts only on a state it applies to, and
 * otherwise changes nothing; another user's Demonstration is not found.
 */

/** The `demonstrations` namespace over the core context. */
export function demonstrationsApi(sdk: BotSdkContext) {
  const act =
    (action: DemonstrationAction) =>
    async ({ userId, ...rest }: WithUser<typeof demonstrationInput>) =>
      actOnDemonstration(sdk, userId, parseInput(demonstrationInput, rest).demonstrationId, action);

  return {
    /** Pauses a recording Demonstration; returns the state it is in now. */
    pause: act("pause"),
    /** Resumes a paused Demonstration. */
    resume: act("resume"),
    /** Ends a live Demonstration as Done: it goes `drafting`. Releases its Screen. */
    done: act("done"),
    /** Ends a live Demonstration `cancelled`. Releases its Screen. */
    cancel: act("cancel"),

    /**
     * A fresh live-view link to a live Demonstration's Screen, which the user drives, never stored.
     * Refused, "This Demonstration has ended.", once it ended.
     */
    view: async ({ userId, ...rest }: WithUser<typeof demonstrationInput>) =>
      screenView(sdk, userId, {
        demonstrationId: parseInput(demonstrationInput, rest).demonstrationId,
      }),

    /**
     * The steps a Demonstration captured, in order, with a mark where the user paused: what the
     * Show me card and "What Planner sees" list. Password values come masked.
     */
    steps: async ({ userId, ...rest }: WithUser<typeof demonstrationInput>) =>
      demonstrationSteps(sdk, userId, parseInput(demonstrationInput, rest).demonstrationId),
  };
}

/** The `demonstrations` namespace's domain methods. */
export type DemonstrationsApi = ReturnType<typeof demonstrationsApi>;
