// Scores the step-6 ladder cases (spec #587). The structural check reads the `start_helper` calls
// and the number of Messages, never the Model's text; the judge (queue-score.ts) reads the task of
// a call or the Messages.

import type { ModelMessage } from "@tanstack/ai";

import type { LadderExpect } from "./ladder-cases";
import { callInputs } from "./routine-score";

/** What a run's Turn left behind. */
export type LadderObserved = {
  status: "running" | "complete" | "error" | "stopped";
  /** The `type` of each `start_helper` call, in order. */
  helperTypes: string[];
  sent: number;
};

export type LadderScore = { passed: boolean; reasons: string[] };

/** The type and task of each `start_helper` call in a Turn's transcript, in order. */
export function helperStarts(
  transcript: readonly ModelMessage[] | null | undefined,
): { type: string; task: string }[] {
  return callInputs(transcript, "start_helper").map((input) => ({
    type: String(input.type),
    task: String(input.task ?? ""),
  }));
}

/** Scores a run's Turn against the case's expectation. */
export function scoreLadder(expected: LadderExpect, observed: LadderObserved): LadderScore {
  const reasons: string[] = [];
  const { helperTypes, sent } = observed;
  if (observed.status !== "complete") {
    reasons.push(`the Turn ended ${observed.status}, expected complete`);
  }
  if (expected.helpers === "none") {
    if (helperTypes.length > 0) {
      reasons.push(`start_helper was called ${helperTypes.length} time(s), expected no call`);
    }
  } else if (expected.helpers === "not-computer-use") {
    if (helperTypes.includes("computer_use")) {
      reasons.push("start_helper was called with a computer_use Helper, expected none");
    }
  } else if (helperTypes.length !== 1) {
    reasons.push(`start_helper was called ${helperTypes.length} time(s), expected 1`);
  } else if (helperTypes[0] !== expected.helpers) {
    reasons.push(`start_helper started a ${helperTypes[0]} Helper, expected ${expected.helpers}`);
  }
  if (expected.sent === "one" && sent !== 1) reasons.push(`sent ${sent} Message(s), expected 1`);
  if (expected.sent === "some" && sent === 0) reasons.push("sent no Message, expected at least 1");
  return { passed: reasons.length === 0, reasons };
}
