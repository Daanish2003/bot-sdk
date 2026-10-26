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

type Call = NonNullable<ModelMessage["toolCalls"]>[number];

/** A call's tool name and arguments as text; a `run_tool` call is the tool it names. */
function unwrapped(call: Call): { name: string; arguments: string } {
  const { name, arguments: text } = call.function;
  if (name !== "run_tool") return { name, arguments: text };
  try {
    const wrapped = JSON.parse(text) as { name?: unknown; args?: unknown };
    if (typeof wrapped.name === "string") {
      return { name: wrapped.name, arguments: JSON.stringify(wrapped.args ?? {}) };
    }
  } catch {
    // Not JSON: it stays a `run_tool` call.
  }
  return { name, arguments: text };
}

/** The name of each tool call in a Turn's transcript, in order. */
export function callNames(transcript: readonly ModelMessage[] | null | undefined): string[] {
  return (transcript ?? []).flatMap((entry) =>
    (entry.toolCalls ?? []).map((call) => unwrapped(call).name),
  );
}

/** The input of each call of `tool` in a Turn's transcript; a call whose input is not JSON is skipped. */
export function callInputs(
  transcript: readonly ModelMessage[] | null | undefined,
  tool: string,
): Record<string, unknown>[] {
  return (transcript ?? []).flatMap((entry) =>
    (entry.toolCalls ?? []).flatMap((call) => {
      const { name, arguments: text } = unwrapped(call);
      if (name !== tool) return [];
      try {
        return [JSON.parse(text) as Record<string, unknown>];
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
      const { name, arguments: text } = unwrapped(call);
      try {
        return { name, args: JSON.parse(text) as unknown };
      } catch {
        return { name, args: text };
      }
    }),
  );
}

/** The next Thursday after `now`, at 09:00 UTC. */
export function nextThursday(now: Date): Date {
  const days = (4 - now.getUTCDay() + 7) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, 9));
}

/**
 * A tool call's input as the judge reads it. A Check-in's `at` also gets its weekday and local time
 * in the user's zone (a judge cannot work that out from an ISO string, and an offset can put it on
 * another day than its date prefix), whether it is in the future, and the time now.
 */
export function describeCall(
  tool: string,
  input: Record<string, unknown>,
  now: Date,
  zone: string,
): string {
  const json = `${tool} ${JSON.stringify(input)}`;
  if (tool !== "set_check_in" || typeof input.at !== "string") return json;
  const at = new Date(input.at);
  if (Number.isNaN(at.getTime())) return json;
  const context = `now is ${now.toISOString()}, the user's time zone is ${zone}`;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input.at)) return `${json} (at has no offset; ${context})`;
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  const [weekday, time] = local.split(", ");
  const when = at.getTime() > now.getTime() ? "in the future" : "in the past";
  return `${json} (at is a ${weekday} at ${time} in the user's zone, ${when}; ${context})`;
}

/** The Check-in or Routine calls of `tool` to judge: the accepted ones, or why none was. */
export function callsToJudge(
  transcript: readonly ModelMessage[] | null | undefined,
  tool: string,
  now: Date,
  zone: string,
): { text: string; rejection?: string } {
  const entries = transcript ?? [];
  const accepted: string[] = [];
  let rejection: string | undefined;
  for (const entry of entries) {
    for (const call of entry.toolCalls ?? []) {
      // A definition-only tool (create_routine, set_check_in) is called through run_tool.
      const { name, arguments: text } = unwrapped(call);
      if (name !== tool) continue;
      const result = entries.find((m) => m.role === "tool" && m.toolCallId === call.id);
      let error: string | undefined;
      if (!result) error = `${tool} has no result`;
      else {
        try {
          const parsed: unknown = JSON.parse(String(result.content));
          const message = (parsed as { error?: unknown } | null)?.error;
          if (message !== undefined) error = `${tool} was rejected: ${String(message)}`;
        } catch {
          // A result that is not JSON is not an error object.
        }
      }
      if (error) {
        rejection = error;
        continue;
      }
      try {
        const input = JSON.parse(text) as Record<string, unknown>;
        accepted.push(describeCall(tool, input, now, zone));
      } catch {
        rejection = `${tool} was called with arguments that are not JSON`;
      }
    }
  }
  return accepted.length > 0 ? { text: accepted.join("\n") } : { text: "", rejection };
}

/** The id of the Turn that took a Trigger, from the Router's answer; a Trigger that waits has none yet. */
export function turnIdOf({ takenBy, waitsFor }: { takenBy?: string; waitsFor?: string }): string {
  if (takenBy) return takenBy;
  throw new Error(`the Trigger waits for the running Turn ${waitsFor ?? "(unknown)"}`);
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
