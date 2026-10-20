import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import type { PromptHash } from "../../../core/server/chat/hooks";
import {
  type CacheCall,
  missingKept,
  promptStartTokens,
  rawCallsOf,
  scoreCache,
  scoreSummary,
  scoreToolSearch,
} from "../../../eval/turn/context-score";

const hashes = (changed?: { section: string; kind: "bug" | "expected" }): PromptHash[] =>
  ["tools", "rules", "first_message", "history"].map((name) => ({
    name,
    hash: name,
    tokens: name === "history" ? 500 : 1000,
    ...(changed?.section === name ? { changed: changed.kind } : {}),
  }));

const call = (over: Partial<CacheCall> = {}): CacheCall => ({
  kind: "turn",
  inputTokens: 4000,
  outputTokens: 20,
  cacheReadTokens: 3000,
  cacheWriteTokens: 0,
  promptHashes: hashes(),
  ...over,
});

const warm = (over: Partial<CacheCall> = {}) =>
  call({ kind: "warm", outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 3500, ...over });

describe("promptStartTokens", () => {
  it("sums every section but the history", () => {
    expect(promptStartTokens(hashes())).toBe(3000);
    expect(promptStartTokens(null)).toBe(0);
  });
});

describe("scoreCache", () => {
  const ok = { readsCache: true, warmed: true };

  it("passes calls that read the Prompt start, and a warm that wrote it", () => {
    const calls = [call({ cacheReadTokens: 0, cacheWriteTokens: 3500 }), call(), warm(), call()];
    expect(scoreCache(calls, ok).passed).toBe(true);
  });

  it("fails a call flagged bug", () => {
    const calls = [call(), call({ promptHashes: hashes({ section: "rules", kind: "bug" }) })];
    const score = scoreCache(calls, { readsCache: false, warmed: true });
    expect(score.passed).toBe(false);
    expect(score.reasons.join()).toContain("section rules changed");
  });

  it("does not fail a call flagged expected, even with no cache read", () => {
    const calls = [
      call(),
      call({ cacheReadTokens: 0, promptHashes: hashes({ section: "tools", kind: "expected" }) }),
      warm(),
    ];
    expect(scoreCache(calls, ok).passed).toBe(true);
  });

  it("fails a later call that reads less than the Prompt start", () => {
    const calls = [call(), call({ cacheReadTokens: 100 }), warm()];
    const score = scoreCache(calls, ok);
    expect(score.passed).toBe(false);
    expect(score.reasons[0]).toContain("call 2 read 100");
  });

  it("leaves the first Turn call alone and skips reads with readsCache off", () => {
    const calls = [call({ cacheReadTokens: 0 }), call({ cacheReadTokens: 0 }), warm()];
    expect(scoreCache(calls, { readsCache: false, warmed: true }).passed).toBe(true);
    expect(scoreCache(calls, ok).passed).toBe(false);
  });

  it("fails without a warm, or a warm that touched no cache or generated text", () => {
    const turns = [call(), call()];
    expect(scoreCache(turns, { readsCache: true, warmed: false }).passed).toBe(false);
    expect(scoreCache(turns, ok).reasons.join()).toContain("recorded no warm");
    expect(scoreCache([...turns, warm({ cacheWriteTokens: 0 })], ok).passed).toBe(false);
    expect(scoreCache([...turns, warm({ outputTokens: 30 })], ok).passed).toBe(false);
  });

  it("fails fewer than two Turn calls", () => {
    expect(scoreCache([call(), warm()], ok).passed).toBe(false);
  });
});

describe("scoreSummary", () => {
  const base = {
    summaryText: "The user has a dog, Biscuit.\n\n[kept]\n[Mon] one\n[Tue] two",
    kept: ["one", "two"],
    reply: ["Your dog is Biscuit."],
    facts: ["Biscuit"],
    status: "complete",
  };

  it("passes a Summary holding the kept Messages and a reply with the facts", () => {
    expect(scoreSummary(base).passed).toBe(true);
  });

  it("fails with no Summary, a missing kept Message, a missing fact or no reply", () => {
    expect(scoreSummary({ ...base, summaryText: null }).passed).toBe(false);
    expect(scoreSummary({ ...base, kept: ["one", "three"] }).reasons[0]).toContain("three");
    expect(scoreSummary({ ...base, reply: ["I forgot."] }).reasons[0]).toContain("Biscuit");
    expect(scoreSummary({ ...base, reply: [] }).passed).toBe(false);
    expect(scoreSummary({ ...base, status: "error" }).passed).toBe(false);
  });

  it("matches facts without regard to case or thousands commas", () => {
    expect(scoreSummary({ ...base, facts: ["2,400"], reply: ["It is 2400 euros"] }).passed).toBe(
      true,
    );
    expect(scoreSummary({ ...base, reply: ["biscuit!"] }).passed).toBe(true);
  });
});

describe("missingKept", () => {
  it("lists the Messages not in the text", () => {
    expect(missingKept("a b", ["a", "c"])).toEqual(["c"]);
  });
});

const transcript = (
  ...steps: { name: string; args: unknown; result?: unknown }[]
): ModelMessage[] =>
  steps.flatMap((step, i): ModelMessage[] => [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `c${i}`,
          type: "function",
          function: { name: step.name, arguments: JSON.stringify(step.args) },
        },
      ],
    },
    ...(step.result === undefined
      ? []
      : [{ role: "tool" as const, toolCallId: `c${i}`, content: JSON.stringify(step.result) }]),
  ]);

describe("scoreToolSearch", () => {
  const good = transcript(
    { name: "describe_tool", args: { name: "set_check_in" }, result: { name: "set_check_in" } },
    { name: "run_tool", args: { name: "set_check_in", args: {} }, result: { ok: true } },
  );

  it("reads raw calls with their results", () => {
    expect(rawCallsOf(good).map((c) => c.name)).toEqual(["describe_tool", "run_tool"]);
    expect(rawCallsOf(good)[1]!.result).toEqual({ ok: true });
  });

  it("passes describe then run with the row there", () => {
    expect(scoreToolSearch("set_check_in", rawCallsOf(good), true).passed).toBe(true);
  });

  it("fails a missing describe, a run before describe, an error result or a missing row", () => {
    const run = { name: "run_tool", args: { name: "set_check_in", args: {} }, result: { ok: 1 } };
    const describe = { name: "describe_tool", args: { name: "set_check_in" }, result: {} };
    expect(scoreToolSearch("set_check_in", rawCallsOf(transcript(run)), true).passed).toBe(false);
    expect(
      scoreToolSearch("set_check_in", rawCallsOf(transcript(run, describe)), true).reasons.join(),
    ).toContain("came before");
    const failed = transcript(describe, { ...run, result: { error: "bad" } });
    expect(scoreToolSearch("set_check_in", rawCallsOf(failed), true).passed).toBe(false);
    expect(scoreToolSearch("set_check_in", rawCallsOf(good), false).passed).toBe(false);
  });

  it("fails the wrong tool and a direct call", () => {
    expect(scoreToolSearch("create_routine", rawCallsOf(good), true).passed).toBe(false);
    const direct = transcript({ name: "set_check_in", args: {}, result: { ok: 1 } });
    expect(scoreToolSearch("set_check_in", rawCallsOf(direct), true).reasons.join()).toContain(
      "directly",
    );
  });
});
