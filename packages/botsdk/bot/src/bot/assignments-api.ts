import {
  assignmentInput,
  botScopeInput,
  raiseAssignmentLimitInput,
} from "@botsdk/client/bot/contract";

import type { BotSdkContext } from "../plugin";
import { parseInput, rpcError, type WithUser } from "../rpc-error";
import { cancelAssignment, listAssignments, raiseAssignmentLimit } from "./assignments";
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

    /**
     * Raises the budget an Assignment handed to one of the user's Bots draws from (#1184), which
     * resumes the work once it has room. Another user's is not found, one that has ended is a
     * conflict, as is one whose Bot can't run to resume, and a limit no higher than it was is refused.
     */
    raiseLimit: async ({ userId, ...rest }: WithUser<typeof raiseAssignmentLimitInput>) => {
      const { botId, assignmentId, callLimit, moneyLimitUsd } = parseInput(
        raiseAssignmentLimitInput,
        rest,
      );
      await requireOwnedBot(sdk.db, userId, botId);
      const raised = await sdk.db.transaction((tx) =>
        raiseAssignmentLimit(
          sdk,
          tx,
          { userId, botId },
          {
            id: assignmentId,
            callLimit,
            moneyLimitMicros:
              moneyLimitUsd === undefined ? undefined : Math.round(moneyLimitUsd * 1_000_000),
          },
        ),
      );
      if ("reason" in raised) {
        switch (raised.reason) {
          case "not_found":
            throw rpcError("NOT_FOUND", "error.assignmentNotFound", "Assignment not found");
          case "ended":
            throw rpcError("CONFLICT", "error.assignmentEnded", "This Assignment already ended");
          case "lowered":
            throw rpcError(
              "BAD_REQUEST",
              "error.assignmentLimitTooLow",
              "A new limit must be higher than the one it has",
            );
          case "cant_run":
            throw rpcError(
              "CONFLICT",
              "error.assignmentCantResume",
              "Its Bot can't run right now, so the limit wasn't raised",
            );
        }
      }
      sdk.runner.wake();
      for (const conversationId of raised.woken) await hintChanged(sdk, conversationId);
    },
  };
}

/** The `assignments` namespace's domain methods. */
export type AssignmentsApi = ReturnType<typeof assignmentsApi>;
