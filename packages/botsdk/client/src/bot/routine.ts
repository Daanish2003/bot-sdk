import { z } from "zod";

/** The days of the week a scheduled Routine runs on. */
export const routineDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type RoutineDay = (typeof routineDays)[number];

/**
 * When a scheduled Routine runs: `days` of the week, at each of `times` (`HH:MM`, 24-hour) in its
 * zone, so it may run several times a day.
 */
export const routineScheduleSchema = z.object({
  days: z
    .array(z.enum(routineDays))
    .min(1, 'schedule.days must name at least one day, like ["mon", "wed"]'),
  times: z
    .array(
      z
        .string()
        .regex(
          /^([01]\d|2[0-3]):[0-5]\d$/,
          'schedule.times must be 24-hour times as HH:MM, like ["08:00", "17:30"]',
        ),
    )
    .min(1, 'schedule.times must name at least one time, like ["08:00"]')
    .refine((times) => new Set(times).size === times.length, {
      error: "schedule.times must not repeat a time",
    }),
});

export type RoutineSchedule = z.infer<typeof routineScheduleSchema>;

/** How a Routine stands: `pending` until the user's Approval. */
export type RoutineState = "pending" | "active" | "paused";

/**
 * A Routine as the client sees it. `nextRunAt` is when its queued fire is due, `null` when none is queued.
 */
export type BotRoutine = {
  id: string;
  name: string;
  prompt: string;
  /** Null on a webhook Routine: a Routine has exactly one of a schedule and a webhook. */
  schedule: RoutineSchedule | null;
  /** Whether it runs when its webhook URL is called (ADR 0021), in place of a schedule. */
  webhook: boolean;
  timeZone: string;
  state: RoutineState;
  approvedAt: Date | null;
  createdAt: Date;
  nextRunAt: Date | null;
};

/**
 * A Routine's Approval in the thread (spec #761), the Rich control of kind `routine_approval`: it
 * holds only the Routine's id, and its state is read from the Routine's row.
 */
export const routineApprovalSchema = z.object({
  kind: z.literal("routine_approval"),
  routineId: z.string(),
});

export type RoutineApproval = z.infer<typeof routineApprovalSchema>;

const weekdays: readonly RoutineDay[] = ["mon", "tue", "wed", "thu", "fri"];

/**
 * A schedule in short words, as the system prompt and the approval card show it: `weekdays 08:00`,
 * `every day 08:00`, `weekends 08:00`, or the days in week order (`mon, thu 08:00`), then its
 * times in order (`weekdays 11:00, 14:00`).
 */
export function scheduleText({ days, times }: RoutineSchedule): string {
  const ordered = routineDays.filter((day) => days.includes(day));
  const named =
    ordered.length === 7
      ? "every day"
      : ordered.length === 5 && weekdays.every((day) => ordered.includes(day))
        ? "weekdays"
        : ordered.length === 2 && ordered.includes("sat") && ordered.includes("sun")
          ? "weekends"
          : ordered.join(", ");
  return `${named} ${[...times].sort().join(", ")}`;
}
