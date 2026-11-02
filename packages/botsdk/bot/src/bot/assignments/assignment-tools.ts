import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { BotSdkContext } from "../../plugin";
import type { LoopKit } from "../agent-loop";
import { hintChanged } from "../conversation";
import {
  assignmentInstructionsInput,
  assignmentTitleInput,
  assignWork,
  assignWorkToolName,
  finishAssignment,
  finishAssignmentToolName,
} from "./assignment";

const assignWorkDefinition = toolDefinition({
  name: assignWorkToolName,
  description:
    "Hand a piece of work to another of the user's Bots, with no Room needed. It wakes that Bot, " +
    "which works on it for as many Turns as it takes and finishes it, and you are woken with the " +
    "result. A wrong name is answered with the names of the user's other Bots.",
  inputSchema: z.object({
    bot: z.string().trim().min(1, "bot must not be empty").meta({
      description: "The name of the Bot to hand it to, one of the user's other Bots.",
    }),
    title: assignmentTitleInput.meta({
      description: "A few words naming the work, which the user sees.",
    }),
    instructions: assignmentInstructionsInput.meta({
      description: "The work, with everything that Bot needs: it can't see this Conversation.",
    }),
  }),
});

const finishAssignmentDefinition = toolDefinition({
  name: finishAssignmentToolName,
  description:
    "End an Assignment handed to you, as done or failed. Your Turn ending never ends one: only " +
    "this does, and only once. Whoever assigned it gets this result.",
  inputSchema: z.object({
    id: z.uuid().meta({ description: "The Assignment's id, as the notice that woke you gave it." }),
    status: z.enum(["done", "failed"]).meta({
      description: "done when the work is finished; failed when it can't be done.",
    }),
    outcome: z.string().trim().min(1, "outcome must not be empty").meta({
      description: "What came of it for whoever assigned it, or why it failed.",
    }),
    for_customer: z
      .string()
      .trim()
      .min(1)
      .optional()
      .meta({
        description:
          "Optional text about the result that may be shown to a Customer. Write it for them, and " +
          "leave out anything private.",
      }),
    when: z.iso
      .datetime({ offset: true, message: "when must be an ISO 8601 time with an offset" })
      .optional()
      .meta({
        description:
          'Optional time the result names, such as when something will happen, like "2026-10-22T09:00:00+01:00".',
      }),
  }),
});

/** The Bot's Assignment tools (spec #1166), each call one Checkpoint. They're deferred tools. */
export function assignmentTools(
  deps: BotSdkContext,
  turn: { id: string; botId: string; userId: string },
  liveActivity: LoopKit["liveActivity"],
) {
  const assign = assignWorkDefinition.server(async ({ bot, title, instructions }, context) => {
    // Set only by a live write, afresh on each try of it.
    let woken: string | undefined;
    const answer = await liveActivity(assignWorkToolName, context?.toolCallId, async (tx) => {
      woken = undefined;
      const assigned = await assignWork(deps, tx, turn, { botName: bot, title, instructions });
      if ("error" in assigned) return assigned;
      woken = assigned.woken;
      return { assigned: assigned.assigned };
    });
    deps.runner.wake();
    if (woken) await hintChanged(deps, woken);
    return answer;
  });

  const finish = finishAssignmentDefinition.server(
    async ({ id, status, outcome, for_customer, when }, context) => {
      // Set only by a live write, afresh on each try of it.
      let woken: string[] = [];
      const answer = await liveActivity(
        finishAssignmentToolName,
        context?.toolCallId,
        async (tx) => {
          woken = [];
          const finished = await finishAssignment(deps, tx, turn, {
            id,
            status,
            result: {
              outcome,
              ...(for_customer && { forCustomer: for_customer }),
              ...(when && { when }),
            },
          });
          if ("error" in finished) return finished;
          woken = finished.woken;
          return { finished: finished.finished };
        },
      );
      deps.runner.wake();
      for (const conversationId of woken) await hintChanged(deps, conversationId);
      return answer;
    },
  );

  return [assign, finish];
}
