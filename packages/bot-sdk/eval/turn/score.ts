// Scores one Turn deterministically, with no judge (spec #463). The inputs are what the Turn left
// behind: the number of Messages it sent, its status, and its transcript.

import type { ModelMessage } from "@tanstack/ai";

import type { TurnCase } from "./cases";

const sendToUserName = "send_to_user";

/** What a Turn did, read from its stream and its transcript. */
export type Observed = {
  status: "complete" | "error" | "stopped";
  error?: string | null;
  /** The Messages the Bot sent, counted from the stream. */
  messages: number;
  /** Each non-empty SendToUser call, in order, with its `endTurn`. */
  sends: { endTurn: boolean }[];
  /** The model calls made after the one that made the last send. */
  callsAfterLastSend: number;
};

/** One case's verdict. `endTurn` is `null` when the Bot sent nothing, so there was nothing to check. */
export type Score = {
  expected: TurnCase["expected"];
  passed: boolean;
  endTurn: boolean | null;
  reasons: string[];
};

function sendsOf(entry: ModelMessage): { endTurn: boolean }[] {
  return (entry.toolCalls ?? []).flatMap((call) => {
    if (call.function.name !== sendToUserName) return [];
    try {
      const args = JSON.parse(call.function.arguments) as { text?: unknown; endTurn?: unknown };
      if (typeof args.text !== "string" || !args.text.trim()) return [];
      return [{ endTurn: args.endTurn === true }];
    } catch {
      return [];
    }
  });
}

/** Reads a Turn's SendToUser calls and its model calls after the last send from its transcript. */
export function observeTranscript(transcript: readonly ModelMessage[] | null | undefined) {
  const calls = (transcript ?? []).filter((entry) => entry.role === "assistant");
  const sends = calls.flatMap(sendsOf);
  const lastSendCall = calls.findLastIndex((entry) => sendsOf(entry).length > 0);
  return { sends, callsAfterLastSend: lastSendCall === -1 ? 0 : calls.length - 1 - lastSendCall };
}

/** Scores a Turn against the case's expectation. */
export function scoreTurn(
  evalCase: Pick<TurnCase, "expected" | "multi">,
  observed: Observed,
): Score {
  const reasons: string[] = [];
  if (observed.status !== "complete") {
    reasons.push(`the Turn ended ${observed.status}${observed.error ? `: ${observed.error}` : ""}`);
  }
  if (evalCase.expected === "quiet") {
    if (observed.messages > 0) reasons.push(`sent ${observed.messages} Message(s), expected none`);
    return { expected: "quiet", passed: reasons.length === 0, endTurn: null, reasons };
  }

  const wanted = evalCase.multi ? 2 : 1;
  if (observed.messages < wanted) {
    reasons.push(`sent ${observed.messages} Message(s), expected at least ${wanted}`);
  }
  let endTurn: boolean | null = null;
  if (observed.sends.length > 0) {
    const last = observed.sends.length - 1;
    const problems: string[] = [];
    if (!observed.sends[last]!.endTurn) problems.push("the last send did not set endTurn");
    if (observed.sends.slice(0, last).some((send) => send.endTurn)) {
      problems.push("an earlier send set endTurn");
    }
    if (observed.callsAfterLastSend > 0) problems.push("the Model was called after the last send");
    endTurn = problems.length === 0;
    reasons.push(...problems);
  }
  return { expected: "reply", passed: reasons.length === 0, endTurn, reasons };
}

/** Pass rate per group: reply cases, quiet cases, and endTurn over the runs that sent something. */
export function tally(scores: readonly Score[]) {
  const group = (picked: boolean[]) => ({
    passed: picked.filter(Boolean).length,
    total: picked.length,
    rate: picked.length === 0 ? null : picked.filter(Boolean).length / picked.length,
  });
  return {
    reply: group(scores.filter((s) => s.expected === "reply").map((s) => s.passed)),
    quiet: group(scores.filter((s) => s.expected === "quiet").map((s) => s.passed)),
    endTurn: group(scores.flatMap((s) => (s.endTurn === null ? [] : [s.endTurn]))),
  };
}
