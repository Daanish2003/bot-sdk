// Scores one tool-use run deterministically, with no judge (spec #519, "Evals"). The inputs are what
// the Turn left behind: its status, the Computer tools in its transcript, and the problems the
// case's own check found in the files and Messages.

import type { ModelMessage } from "@tanstack/ai";

import type { ComputerCase } from "./cases";

/** The Bot's Computer tools: a call to any of them touches the Computer. */
export const computerToolNames = ["shell", "read", "write", "edit", "list"] as const;

/** What a Turn did. */
export type Observed = {
  status: "complete" | "error" | "stopped";
  error?: string | null;
  /** Each Computer tool the Turn called, in order. */
  tools: string[];
  /** What the case's check found wrong with the files and the Messages (none for a `none` case). */
  problems: string[];
};

export type Score = { expected: ComputerCase["expected"]; passed: boolean; reasons: string[] };

/** The Computer tools called in a Turn's transcript, in order. */
export function observeTools(transcript: readonly ModelMessage[] | null | undefined): string[] {
  const computerTools: readonly string[] = computerToolNames;
  return (transcript ?? [])
    .filter((entry) => entry.role === "assistant")
    .flatMap((entry) => entry.toolCalls ?? [])
    .map((call) => call.function.name)
    .filter((name) => computerTools.includes(name));
}

/** Scores a Turn against the case's expectation. */
export function scoreComputerRun(expected: ComputerCase["expected"], observed: Observed): Score {
  const reasons: string[] = [];
  if (observed.status !== "complete") {
    reasons.push(`the Turn ended ${observed.status}${observed.error ? `: ${observed.error}` : ""}`);
  }
  if (expected === "use") {
    if (observed.tools.length === 0) reasons.push("never used the Computer");
    reasons.push(...observed.problems);
  } else if (observed.tools.length > 0) {
    reasons.push(`used the Computer in plain chat: ${observed.tools.join(", ")}`);
  }
  return { expected, passed: reasons.length === 0, reasons };
}

type Row = { passed: number; total: number; rate: number | null };

const row = (passes: boolean[]): Row => ({
  passed: passes.filter(Boolean).length,
  total: passes.length,
  rate: passes.length === 0 ? null : passes.filter(Boolean).length / passes.length,
});

/** Pass rate per case, and per group: `use` cases and `none` (plain chat) cases. No threshold. */
export function tallyComputer(
  runs: readonly { caseId: string; expected: string; passed: boolean }[],
) {
  const cases: Record<string, Row> = {};
  for (const id of new Set(runs.map((run) => run.caseId))) {
    cases[id] = row(runs.filter((run) => run.caseId === id).map((run) => run.passed));
  }
  return {
    cases,
    use: row(runs.filter((run) => run.expected === "use").map((run) => run.passed)),
    none: row(runs.filter((run) => run.expected === "none").map((run) => run.passed)),
  };
}
