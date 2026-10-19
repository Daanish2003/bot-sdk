// Scores the step-4 eval cases (spec #543). The structural check reads the Turn's tool calls and
// the number of Messages it sent, never the Model's text; the judge (queue-score.ts) reads a tool
// call's input or the Messages.

import type { ModelMessage } from "@tanstack/ai";

import type { RoutineExpect } from "./routine-cases";

/** What a run's Turn left behind: its status, the tool calls it made in order, the Messages it sent. */
export type RoutineObserved = {
  status: "running" | "complete" | "error" | "stopped";
  calls: string[];
  sent: number;
};

export type RoutineScore = { passed: boolean; reasons: string[] };

/** The name of each tool call in a Turn's transcript, in order. */
export function callNames(transcript: readonly ModelMessage[] | null | undefined): string[] {
  return (transcript ?? []).flatMap((entry) =>
    (entry.toolCalls ?? []).map((call) => call.function.name),
  );
}

/** The input of each call of `tool` in a Turn's transcript; a call whose input is not JSON is skipped. */
export function callInputs(
  transcript: readonly ModelMessage[] | null | undefined,
  tool: string,
): Record<string, unknown>[] {
  return (transcript ?? []).flatMap((entry) =>
    (entry.toolCalls ?? []).flatMap((call) => {
      if (call.function.name !== tool) return [];
      try {
        return [JSON.parse(call.function.arguments) as Record<string, unknown>];
      } catch {
        return [];
      }
    }),
  );
}

/** Every tool call in a Turn's transcript, in order, with its args (as text when they are not JSON). */
export function toolCallsOf(
  transcript: readonly ModelMessage[] | null | undefined,
): { name: string; args: unknown }[] {
  return (transcript ?? []).flatMap((entry) =>
    (entry.toolCalls ?? []).map((call) => {
      try {
        return { name: call.function.name, args: JSON.parse(call.function.arguments) as unknown };
      } catch {
        return { name: call.function.name, args: call.function.arguments };
      }
    }),
  );
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The next Thursday after `now`, at 09:00 UTC. */
export function nextThursday(now: Date): Date {
  const days = (4 - now.getUTCDay() + 7) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 9));
}

/**
 * A tool call's input as the judge reads it. A Check-in's `at` also gets the weekday of its own
 * local date (a judge cannot work that out from an ISO string), whether it is in the future, and the
 * time now and the user's zone.
 */
export function describeCall(
  tool: string,
  input: Record<string, unknown>,
  now: Date,
  zone: string,
): string {
  const json = `${tool} ${JSON.stringify(input)}`;
  const at = typeof input.at === "string" ? input.at : "";
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(at);
  if (tool !== "set_check_in" || !date) return json;
  const day = new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])));
  const when = new Date(at).getTime() > now.getTime() ? "in the future" : "in the past";
  return `${json} (at is a ${weekdays[day.getUTCDay()]}, ${when}; now is ${now.toISOString()}, the user's time zone is ${zone})`;
}

/** Fails a judged case whose judged text is empty, so the judge is never skipped without a reason. */
export function failEmptyJudgement(score: RoutineScore, judged: string, on: string): RoutineScore {
  if (judged.trim()) return score;
  return { passed: false, reasons: [...score.reasons, `nothing to judge: no ${on} input`] };
}

/** Scores a run's Turn against the case's expectation. */
export function scoreRoutine(expected: RoutineExpect, observed: RoutineObserved): RoutineScore {
  const reasons: string[] = [];
  if (observed.status !== "complete") {
    reasons.push(`the Turn ended ${observed.status}, expected complete`);
  }
  for (const [tool, wanted] of [
    ["create_routine", expected.createRoutine],
    ["set_check_in", expected.setCheckIn],
  ] as const) {
    if (wanted === undefined) continue;
    const called = observed.calls.includes(tool);
    if (wanted && !called) reasons.push(`${tool} was not called`);
    if (!wanted && called) reasons.push(`${tool} was called, expected no call`);
  }
  const { sent } = observed;
  if (expected.sent === "none" && sent > 0) reasons.push(`sent ${sent} Message(s), expected none`);
  if (expected.sent === "one" && sent !== 1) reasons.push(`sent ${sent} Message(s), expected 1`);
  if (expected.sent === "some" && sent === 0) reasons.push("sent no Message, expected at least 1");
  return { passed: reasons.length === 0, reasons };
}
