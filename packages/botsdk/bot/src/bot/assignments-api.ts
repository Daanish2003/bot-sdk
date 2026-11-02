import { assignmentInput, botScopeInput } from "@botsdk/client/bot/contract";

import type { BotSdkContext } from "../plugin";
import { parseInput, rpcError, type WithUser } from "../rpc-error";
import { cancelAssignment, listAssignments } from "./assignments";
import { hintChanged } from "./conversation";
import { requireOwnedBot } from "./owned-bot";

/*
 * The `assignments` namespace's domain methods (spec #1166), taking the user's id as `bots` does.
 * The owner reads and cancels; only a Bot creates an Assignment.
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

    /**
     * Cancels an Assignment handed to one of the user's Bots, whoever made it: it moves to
     * `cancelled`, and the Bots on either side are told or woken. Another user's is not found, and
     * one that has ended is a conflict.
     */
    cancel: async ({ userId, ...rest }: WithUser<typeof assignmentInput>) => {
      const { botId, assignmentId } = parseInput(assignmentInput, rest);
      await requireOwnedBot(sdk.db, userId, botId);
      const cancelled = await sdk.db.transaction((tx) =>
        cancelAssignment(sdk, tx, { by: "user", userId, botId }, assignmentId),
      );
      if ("error" in cancelled) {
        throw cancelled.reason === "ended"
          ? rpcError("CONFLICT", "error.assignmentEnded", "This Assignment already ended")
          : rpcError("NOT_FOUND", "error.assignmentNotFound", "Assignment not found");
      }
      sdk.runner.wake();
      for (const conversationId of cancelled.woken) await hintChanged(sdk, conversationId);
    },
  };
}

/** The `assignments` namespace's domain methods. */
export type AssignmentsApi = ReturnType<typeof assignmentsApi>;
