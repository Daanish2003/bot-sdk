import { type BotAssignment, assignmentTriggerPrefix } from "./assignment";
import type { BotCheckIn } from "./check-in";
import type { BotHelper } from "./helper";
import type { BotRoutine } from "./routine";

/**
 * Why a Trigger was skipped: the user skipped it, its Bot was paused or reset (spec #1007), or it
 * was a handoff past the Room's hop limit (spec #1055).
 */
export type TriggerSkipReason = "cancelled" | "paused" | "reset" | "hop_limit";

/**
 * One Trigger as the Tasks view lists it (spec #1007). `label` names what it is: a Routine's name, a
 * Check-in's note, a Helper's gist or an Assignment's title, `null` for a user Message or an Approval's answer. The
 * `skipped` fields are set only on the Done tab's skipped runs.
 */
export type TaskTrigger = {
  id: string;
  source: "user" | "routine" | "check_in" | "helper" | "approval" | "agent" | "assignment";
  /** `web`, `schedule`, `webhook`, `helper`, `email`, `room` (a handoff), `assignment`, or a messaging platform's id. */
  channel: string;
  label: string | null;
  receivedAt: Date;
  skippedAt: Date | null;
  skipReason: TriggerSkipReason | null;
};

/** A Helper that has ended, with when. */
export type DoneHelper = BotHelper & { endedAt: Date | null };

/**
 * A Bot's Tasks view (spec #1007), the one read behind the "Tasks N" popover. It is a view over
 * existing things, not a thing of its own. In progress holds the running Turn, the running and
 * waiting Helpers and the Assignments that haven't ended; Scheduled the Triggers waiting in the Conversation queue, the Routines and the
 * pending Check-ins; Done the last 7 days' ended Helpers and Assignments, fired Check-ins and skipped Triggers,
 * each kind newest first.
 */
export type BotTasks = {
  /** The running Turn, with its Conversation: the Bot's 1:1 or one of its Rooms (spec #1055). */
  inProgress: {
    turn: { id: string; startedAt: Date; conversationId: string } | null;
    helpers: BotHelper[];
    assignments: BotAssignment[];
  };
  scheduled: { triggers: TaskTrigger[]; routines: BotRoutine[]; checkIns: BotCheckIn[] };
  done: {
    helpers: DoneHelper[];
    assignments: BotAssignment[];
    checkIns: BotCheckIn[];
    skipped: TaskTrigger[];
  };
};

/** How long Done reaches back. */
export const tasksDoneDays = 7;

/**
 * The "Tasks N" count: the running Turn, the live Helpers and the waiting Triggers, plus the
 * Assignments in progress that none of those already show (spec #1166). One waiting in the queue is
 * its Trigger, and a running Turn is the work on the Assignments the Bot has, so neither counts twice.
 */
export function taskCount({ inProgress, scheduled }: BotTasks): number {
  const assignments = inProgress.turn
    ? 0
    : inProgress.assignments.filter(
        (assignment) =>
          !scheduled.triggers.some((trigger) =>
            trigger.id.startsWith(`${assignmentTriggerPrefix}${assignment.id}`),
          ),
      ).length;
  return (
    (inProgress.turn ? 1 : 0) + inProgress.helpers.length + scheduled.triggers.length + assignments
  );
}
