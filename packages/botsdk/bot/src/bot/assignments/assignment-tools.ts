import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { BotSdkContext } from "../../plugin";
import type { LoopKit } from "../agent-loop";
import { hintChanged } from "../conversation";
import {
  addAssignmentNote,
  addAssignmentNoteToolName,
  assignmentForCustomerInput,
  assignmentInstructionsInput,
  assignmentOutcomeInput,
  assignmentTitleInput,
  assignWork,
  assignWorkToolName,
  cancelAssignment,
  cancelAssignmentToolName,
  finishAssignment,
  finishAssignmentToolName,
  readAssignments,
  readAssignmentToolName,
} from "./assignment";

const assignWorkDefinition = toolDefinition({
  name: assignWorkToolName,
  description:
    "Hand a piece of work to another of the user's Bots, with no Room needed. It wakes that Bot, " +
    "which works on it for as many Turns as it takes and finishes it, and you are woken with the " +
    "result. A wrong name is answered with the names of the user's other Bots. Called while you " +
    "work on an Assignment, unless your Turn also took the user's Message, it splits part of that " +
    "one off as a child: yours shows blocked until " +
    "its children end, a child that fails doesn't fail yours, and finishing yours cancels those " +
    "still open. A child draws from your Assignment's budget. A chain of Assignments stops at 3 deep.",
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
    parent: z
      .uuid()
      .optional()
      .meta({
        description:
          "The id of the Assignment handed to you that this is part of. Only needed when this Turn " +
          "didn't start from it, started from several, or also took the user's Message, which " +
          "makes this new work otherwise.",
      }),
  }),
});

const finishAssignmentDefinition = toolDefinition({
  name: finishAssignmentToolName,
  description:
    "End an Assignment handed to you, as done or failed. Your Turn ending never ends one: only " +
    "this does, and only once. Whoever assigned it gets this result. Any child Assignments of " +
    "it still open are cancelled.",
  inputSchema: z.object({
    id: z.uuid().meta({ description: "The Assignment's id, as the notice that woke you gave it." }),
    status: z.enum(["done", "failed"]).meta({
      description: "done when the work is finished; failed when it can't be done.",
    }),
    outcome: assignmentOutcomeInput.meta({
      description:
        "What came of it for whoever assigned it, or why it failed. A Secret's value in it is masked.",
    }),
    for_customer: assignmentForCustomerInput.optional().meta({
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

const assignmentId = z.uuid().meta({ description: "The Assignment's id." });

const readAssignmentDefinition = toolDefinition({
  name: readAssignmentToolName,
  description:
    "Read the status and log of an Assignment you are part of, whether you were handed it or " +
    "started it. Without an id, list the ones you are part of.",
  inputSchema: z.object({
    id: assignmentId.optional(),
  }),
});

const addAssignmentNoteDefinition = toolDefinition({
  name: addAssignmentNoteToolName,
  description:
    "Add a note to the log of an Assignment handed to you, such as how far you are. The user and " +
    "the Bot that started it can read it. It can't be changed or removed.",
  inputSchema: z.object({
    id: assignmentId,
    note: z.string().trim().min(1, "note must not be empty").max(2000).meta({
      description: "A short note on how the work stands.",
    }),
  }),
});

const cancelAssignmentDefinition = toolDefinition({
  name: cancelAssignmentToolName,
  description:
    "Cancel an Assignment you started that hasn't ended, so the work on it stops. Any child " +
    "Assignments of it still open are cancelled too. Only the Bot that started it may.",
  inputSchema: z.object({ id: assignmentId }),
});

/** The Bot's Assignment tools (spec #1166), each call one Checkpoint. They're deferred tools. */
export function assignmentTools(
  deps: BotSdkContext,
  turn: { id: string; botId: string; userId: string },
  liveActivity: LoopKit["liveActivity"],
) {
  const assign = assignWorkDefinition.server(
    async ({ bot, title, instructions, parent }, context) => {
      // Set only by a live write, afresh on each try of it.
      let woken: string[] = [];
      const answer = await liveActivity(assignWorkToolName, context?.toolCallId, async (tx) => {
        woken = [];
        const assigned = await assignWork(deps, tx, turn, {
          botName: bot,
          title,
          instructions,
          parent,
        });
        if ("error" in assigned) return assigned;
        woken = assigned.woken;
        return { assigned: assigned.assigned };
      });
      deps.runner.wake();
      for (const conversationId of woken) await hintChanged(deps, conversationId);
      return answer;
    },
  );

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

  const read = readAssignmentDefinition.server(async ({ id }, context) =>
    liveActivity(readAssignmentToolName, context?.toolCallId, (tx) =>
      readAssignments(tx, turn.botId, id),
    ),
  );

  const note = addAssignmentNoteDefinition.server(async ({ id, note }, context) => {
    // Set only by a live write, afresh on each try of it.
    let woken: string | undefined;
    const answer = await liveActivity(
      addAssignmentNoteToolName,
      context?.toolCallId,
      async (tx) => {
        woken = undefined;
        const noted = await addAssignmentNote(deps, tx, turn, { id, note });
        if ("error" in noted) return noted;
        woken = noted.woken;
        return { noted: noted.noted };
      },
    );
    if (woken) await hintChanged(deps, woken);
    return answer;
  });

  const cancel = cancelAssignmentDefinition.server(async ({ id }, context) => {
    // Set only by a live write, afresh on each try of it.
    let woken: string[] = [];
    const answer = await liveActivity(cancelAssignmentToolName, context?.toolCallId, async (tx) => {
      woken = [];
      const cancelled = await cancelAssignment(deps, tx, { by: "bot", turn }, id);
      if ("error" in cancelled) return { error: cancelled.error };
      woken = cancelled.woken;
      return { cancelled: cancelled.cancelled };
    });
    deps.runner.wake();
    for (const conversationId of woken) await hintChanged(deps, conversationId);
    return answer;
  });

  return [assign, finish, read, note, cancel];
}
