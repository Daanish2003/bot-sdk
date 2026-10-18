// Scores the step-3 eval cases (spec #510). The structural check reads the Turns and the Triggers
// they took, never the Model's text. The judge reads the Bot's reply: the pattern of
// eval/memory/judge.ts, with a yes or no and a reason.

import { type QueueCase, refusalCaseIds } from "./queue-cases";

/** What a run left behind: its Triggers in the order sent, and the Turns that took them. */
export type QueueObserved = {
  /** The id of each Trigger, in the order the case sent them. */
  triggerIds: string[];
  /** The Turns that took at least one Trigger, oldest first, with how many Messages each sent. */
  turns: {
    status: "running" | "complete" | "error" | "stopped";
    triggerIds: string[];
    sent: number;
  }[];
};

export type QueueScore = { passed: boolean; reasons: string[] };

/** Scores a run's Turns and Triggers against the case's expectation. */
export function scoreQueue(kind: QueueCase["id"], observed: QueueObserved): QueueScore {
  const reasons: string[] = [];
  const { triggerIds, turns } = observed;
  const last = turns.at(-1);
  // A refusal case is one Message the Bot cannot do or understand: its one Turn must still send the
  // user a reply.
  if (kind === "batching" || (refusalCaseIds as readonly string[]).includes(kind)) {
    if (turns.length !== 1) {
      reasons.push(`${turns.length} Turns took Triggers, expected exactly 1`);
    } else if (turns[0]!.triggerIds.length !== triggerIds.length) {
      reasons.push(`the Turn took ${turns[0]!.triggerIds.length} of ${triggerIds.length} Triggers`);
    }
    if (last && last.status !== "complete") {
      reasons.push(`the Turn ended ${last.status}, expected complete`);
    }
    // A plain-text answer stays private: the user saw nothing (#516).
    if (last && last.sent === 0) reasons.push("the Turn sent nothing, expected a reply");
  } else {
    if (turns.length !== 2) {
      reasons.push(`${turns.length} Turn(s) took Triggers, expected 2`);
    } else {
      if (turns[0]!.status !== "stopped") {
        reasons.push(`the first Turn ended ${turns[0]!.status}, expected stopped`);
      }
      if (!turns[0]!.triggerIds.includes(triggerIds[0]!)) {
        reasons.push("the first Turn did not take the first Trigger");
      }
    }
    if (last) {
      if (!last.triggerIds.includes(triggerIds.at(-1)!)) {
        reasons.push("the last Turn did not take the correction");
      }
      if (last.status !== "complete") {
        reasons.push(`the last Turn ended ${last.status}, expected complete`);
      }
      if (last.sent === 0) reasons.push("the last Turn sent nothing, expected a reply");
    }
  }
  return { passed: reasons.length === 0, reasons };
}

/** The judge's prompt: the case's criterion and the Bot's reply, answered as a verdict and a reason. */
export function judgePrompt({ criterion, reply }: { criterion: string; reply: string }): string {
  return (
    "I will give you what a user asked a chat assistant and the assistant's reply. Decide whether the " +
    "reply meets the criterion.\n\n" +
    `Criterion: ${criterion}\n\nReply: ${reply || "(the assistant sent nothing)"}\n\n` +
    "Answer in exactly this form, with no other text:\nVerdict: yes or no\nReason: one short sentence"
  );
}

/** Reads the judge's answer; anything that does not start with a yes verdict counts as no. */
export function parseVerdict(answer: string): { correct: boolean; reason: string } {
  const verdict = /^\s*verdict:\s*(yes|no)\b/i.exec(answer);
  const reason = /^\s*reason:\s*(.*)$/im.exec(answer)?.[1]?.trim();
  return { correct: verdict?.[1]?.toLowerCase() === "yes", reason: reason || answer.trim() };
}

/** Judges one reply with `complete`, which sends a prompt to the judge Model at temperature 0. */
export async function judge(
  complete: (prompt: string) => Promise<string>,
  input: { criterion: string; reply: string },
) {
  const answer = await complete(judgePrompt(input));
  return parseVerdict(answer);
}

/** Pass counts per case: structural passes, and judge passes over the runs that were judged. */
export function tallyQueue(
  runs: readonly { caseId: string; structural: boolean; judge: boolean | null }[],
) {
  const out: Record<string, { runs: number; structural: number; judge: number }> = {};
  for (const run of runs) {
    const row = (out[run.caseId] ??= { runs: 0, structural: 0, judge: 0 });
    row.runs += 1;
    if (run.structural) row.structural += 1;
    if (run.judge) row.judge += 1;
  }
  return out;
}
