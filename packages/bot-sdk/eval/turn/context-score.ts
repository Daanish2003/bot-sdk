// Scores the step-8 evals (spec #665, #678): cache stability, Summaries and tool search. Everything
// here is deterministic and reads what a run left behind (usage rows, a Summary's text, a Turn's
// transcript); the judge (queue-score.ts) only reads the Bot's answers.

import type { ModelMessage } from "@tanstack/ai";

import type { PromptHash } from "../../core/server/chat/hooks";

export type ContextScore = { passed: boolean; reasons: string[] };

const scored = (reasons: string[]): ContextScore => ({ passed: reasons.length === 0, reasons });

/** One model call's `chat.usage` row, as the cache check reads it. */
export type CacheCall = {
  kind: "turn" | "warm";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptHashes: PromptHash[] | null;
};

/**
 * The share of the Prompt start's estimated size that a call must read from the cache. The
 * estimate is characters / 4, which runs a little high for English and low for JSON, so a call
 * that reads most of it counts.
 */
export const promptStartReadShare = 0.8;

/** The estimated size of the Prompt start a call sent: every section but the history. */
export function promptStartTokens(hashes: readonly PromptHash[] | null): number {
  return (hashes ?? [])
    .filter((entry) => entry.name !== "history")
    .reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
}

/**
 * Scores a scripted multi-Turn Conversation's calls, oldest first. With `readsCache` off (the dry
 * run, whose fake Model reports whatever the script says) only the hashes are checked.
 *
 * - No call is flagged `bug`: a section that differs from the call before while the Prompt start is
 *   the same, so the cache missed before the newest message.
 * - Every Turn call after the first reads at least `promptStartReadShare` of the Prompt start from
 *   the cache, unless it is flagged `expected` (the first call on a new Prompt start).
 * - The warming call ran, and it billed a cache write or read, so Anthropic took `max_tokens: 0`.
 */
export function scoreCache(
  calls: readonly CacheCall[],
  { readsCache, warmed }: { readsCache: boolean; warmed: boolean },
): ContextScore {
  const reasons: string[] = [];
  const turns = calls.filter((call) => call.kind === "turn");
  if (turns.length < 2) {
    reasons.push(`only ${turns.length} Turn call(s) were recorded, expected 2 or more`);
  }
  for (const [index, call] of calls.entries()) {
    const flagged = (call.promptHashes ?? []).find((entry) => entry.changed);
    if (flagged?.changed === "bug") {
      reasons.push(
        `call ${index + 1} (${call.kind}): section ${flagged.name} changed with no new Prompt start`,
      );
    }
  }
  if (readsCache) {
    let seen = false;
    for (const [index, call] of calls.entries()) {
      if (call.kind !== "turn") continue;
      const first = !seen;
      seen = true;
      if (first) continue;
      if ((call.promptHashes ?? []).some((entry) => entry.changed === "expected")) continue;
      const wanted = Math.floor(promptStartTokens(call.promptHashes) * promptStartReadShare);
      if (call.cacheReadTokens < wanted) {
        reasons.push(
          `call ${index + 1} read ${call.cacheReadTokens} cached tokens, expected at least ${wanted} (the Prompt start)`,
        );
      }
    }
  }
  const warms = calls.filter((call) => call.kind === "warm");
  if (!warmed)
    reasons.push("the warming call did not run (warmBot skipped or failed; see its log)");
  else if (warms.length === 0) reasons.push("warmBot said warmed but recorded no warm usage row");
  for (const warm of warms) {
    if (readsCache && warm.cacheReadTokens + warm.cacheWriteTokens === 0) {
      reasons.push("a warm call neither wrote nor read the cache");
    }
    if (warm.outputTokens > 1) {
      reasons.push(`a warm call generated ${warm.outputTokens} output tokens`);
    }
  }
  return scored(reasons);
}

/**
 * The entries of `kept` that a Summary's text lacks. A Summary holds the Bot's last Messages to the
 * user word for word, each on a line of its own after the time it was sent.
 */
export function missingKept(summaryText: string, kept: readonly string[]): string[] {
  return kept.filter((text) => !summaryText.includes(text));
}

/** Scores a Conversation that was pushed past the Summary threshold. */
export function scoreSummary(observed: {
  /** The text of the Summary the away job wrote, or `null` when none was written. */
  summaryText: string | null;
  /** The Bot's last Messages to the user before the Summary, oldest first. */
  kept: readonly string[];
  /** The Messages the Turn after the Summary sent. */
  reply: readonly string[];
  /** Facts the reply must give, found by a case-insensitive match. */
  facts: readonly string[];
  status: string;
}): ContextScore {
  const reasons: string[] = [];
  if (observed.summaryText === null) reasons.push("no Summary was written");
  else {
    for (const text of missingKept(observed.summaryText, observed.kept)) {
      reasons.push(`the Summary lacks the Message word for word: ${text.slice(0, 60)}`);
    }
  }
  if (observed.status !== "complete") {
    reasons.push(`the Turn ended ${observed.status}, expected complete`);
  }
  const reply = observed.reply.join("\n").toLowerCase();
  if (!reply) reasons.push("the Turn after the Summary sent no Message");
  for (const fact of observed.facts) {
    if (!reply.includes(fact.toLowerCase())) reasons.push(`the reply lacks the fact "${fact}"`);
  }
  return scored(reasons);
}

type Call = NonNullable<ModelMessage["toolCalls"]>[number];

/** One tool call as the Model made it (`run_tool` and `describe_tool` left as they are), with its result. */
export type RawCall = { name: string; args: Record<string, unknown>; result: unknown };

/** Every tool call in a Turn's transcript, in order, with the result the Turn recorded for it. */
export function rawCallsOf(transcript: readonly ModelMessage[] | null | undefined): RawCall[] {
  const entries = transcript ?? [];
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
  return entries.flatMap((entry) =>
    (entry.toolCalls ?? []).map((call: Call) => {
      const args = parse(call.function.arguments);
      const result = entries.find((m) => m.role === "tool" && m.toolCallId === call.id);
      return {
        name: call.function.name,
        args: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
        result: result ? parse(String(result.content)) : undefined,
      };
    }),
  );
}

const isError = (result: unknown) =>
  result === undefined || (typeof result === "object" && result !== null && "error" in result);

/**
 * Scores a tool search case: the Bot loaded `tool` with `describe_tool` and then called it with
 * `run_tool`, a call did not come back as an error, and the row the tool writes (or reads) is there
 * (`rowFound`, checked by the run in the database).
 */
export function scoreToolSearch(
  tool: string,
  calls: readonly RawCall[],
  rowFound: boolean,
): ContextScore {
  const reasons: string[] = [];
  const described = calls.findIndex((c) => c.name === "describe_tool" && c.args.name === tool);
  const ran = calls.findIndex((c) => c.name === "run_tool" && c.args.name === tool);
  if (described < 0) reasons.push(`describe_tool was not called for ${tool}`);
  if (ran < 0) reasons.push(`run_tool was not called for ${tool}`);
  else {
    if (described >= 0 && described > ran) {
      reasons.push(`run_tool came before describe_tool for ${tool}`);
    }
    const runs = calls.filter((c) => c.name === "run_tool" && c.args.name === tool);
    if (runs.every((c) => isError(c.result)))
      reasons.push(`run_tool ${tool} came back as an error`);
  }
  if (calls.some((c) => c.name === tool)) {
    reasons.push(`${tool} was called directly, not through run_tool`);
  }
  if (!rowFound) reasons.push(`the row ${tool} should leave is not there`);
  return scored(reasons);
}
