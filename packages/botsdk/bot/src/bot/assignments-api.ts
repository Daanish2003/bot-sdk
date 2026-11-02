import { botScopeInput } from "@botsdk/client/bot/contract";

import type { BotSdkContext } from "../plugin";
import { parseInput, type WithUser } from "../rpc-error";
import { listAssignments } from "./assignments";
import { requireOwnedBot } from "./owned-bot";

/*
 * The `assignments` namespace's domain methods (spec #1166), taking the user's id as `bots` does.
 * The owner reads; only a Bot creates an Assignment.
 */

/** The `assignments` namespace over the core context. */
export function assignmentsApi(sdk: BotSdkContext) {
  return {
    /** The Assignments handed to one of the user's Bots, oldest first. Another user's is not found. */
    list: async ({ userId, ...rest }: WithUser<typeof botScopeInput>) => {
      const { botId } = parseInput(botScopeInput, rest);
      await requireOwnedBot(sdk.db, userId, botId);
      return listAssignments(sdk.db, botId);
    },
  };
}

/** The `assignments` namespace's domain methods. */
export type AssignmentsApi = ReturnType<typeof assignmentsApi>;
