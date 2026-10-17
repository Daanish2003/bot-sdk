import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { queueCases } from "../../../eval/turn/queue-cases";
import {
  judgePrompt,
  parseVerdict,
  type QueueObserved,
  scoreQueue,
  tallyQueue,
} from "../../../eval/turn/queue-score";
import { sentTexts } from "../../../eval/turn/score";

const turn = (status: QueueObserved["turns"][number]["status"], triggerIds: string[]) => ({
  status,
  triggerIds,
});

describe("scoreQueue, batching", () => {
  const ids = ["a", "b", "c"];
  it("passes when exactly one Turn took all three Triggers and completed", () => {
    expect(scoreQueue("batching", { triggerIds: ids, turns: [turn("complete", ids)] })).toEqual({
      passed: true,
      reasons: [],
    });
  });

  it("fails when the Triggers were split over two Turns", () => {
    const score = scoreQueue("batching", {
      triggerIds: ids,
      turns: [turn("complete", ["a"]), turn("complete", ["b", "c"])],
    });
    expect(score.passed).toBe(false);
    expect(score.reasons).toContain("2 Turns took Triggers, expected exactly 1");
  });

  it("fails when one Turn left a Trigger untaken", () => {
    const score = scoreQueue("batching", {
      triggerIds: ids,
      turns: [turn("complete", ["a", "b"])],
    });
    expect(score.passed).toBe(false);
    expect(score.reasons).toContain("the Turn took 2 of 3 Triggers");
  });

  it("fails when the Turn did not complete", () => {
    const score = scoreQueue("batching", { triggerIds: ids, turns: [turn("error", ids)] });
    expect(score.reasons).toContain("the Turn ended error, expected complete");
  });
});

describe("scoreQueue, interrupting", () => {
  const ids = ["first", "fix"];
  it("passes when the first Turn ended stopped and a second took the correction", () => {
    const score = scoreQueue("interrupting", {
      triggerIds: ids,
      turns: [turn("stopped", ["first"]), turn("complete", ["fix"])],
    });
    expect(score).toEqual({ passed: true, reasons: [] });
  });

  it("fails when the first Turn was not stopped", () => {
    const score = scoreQueue("interrupting", {
      triggerIds: ids,
      turns: [turn("complete", ["first"]), turn("complete", ["fix"])],
    });
    expect(score.passed).toBe(false);
    expect(score.reasons).toContain("the first Turn ended complete, expected stopped");
  });

  it("fails when the correction did not reach a later Turn", () => {
    const score = scoreQueue("interrupting", {
      triggerIds: ids,
      turns: [turn("complete", ["first", "fix"])],
    });
    expect(score.passed).toBe(false);
    expect(score.reasons).toContain("1 Turn(s) took Triggers, expected 2");
  });

  it("fails when the last Turn did not take the correction or did not complete", () => {
    const score = scoreQueue("interrupting", {
      triggerIds: ids,
      turns: [turn("stopped", ["first", "fix"]), turn("error", [])],
    });
    expect(score.passed).toBe(false);
    expect(score.reasons).toContain("the last Turn did not take the correction");
    expect(score.reasons).toContain("the last Turn ended error, expected complete");
  });
});

describe("judge", () => {
  it("parses the verdict and the reason, and reads anything else as no", () => {
    expect(parseVerdict("Verdict: yes\nReason: it covers all three.")).toEqual({
      correct: true,
      reason: "it covers all three.",
    });
    expect(parseVerdict("verdict: NO\nreason: no vegetarian")).toEqual({
      correct: false,
      reason: "no vegetarian",
    });
    expect(parseVerdict("Maybe, yes and no")).toEqual({
      correct: false,
      reason: "Maybe, yes and no",
    });
  });

  it("puts the case's criterion and the Bot's reply in the prompt", () => {
    const prompt = judgePrompt({ criterion: "Says Thursday.", reply: "Booked for Thursday." });
    expect(prompt).toContain("Says Thursday.");
    expect(prompt).toContain("Booked for Thursday.");
  });
});

describe("tallyQueue", () => {
  it("rates structural and judge passes per case", () => {
    expect(
      tallyQueue([
        { caseId: "batching", structural: true, judge: true },
        { caseId: "batching", structural: false, judge: null },
        { caseId: "interrupting", structural: true, judge: false },
      ]),
    ).toEqual({
      batching: { runs: 2, structural: 1, judge: 1 },
      interrupting: { runs: 1, structural: 1, judge: 0 },
    });
  });
});

describe("sentTexts", () => {
  it("reads the text of each non-empty SendToUser call", () => {
    const call = (text: string): NonNullable<ModelMessage["toolCalls"]>[number] => ({
      id: text,
      type: "function",
      function: { name: "send_to_user", arguments: JSON.stringify({ text, endTurn: true }) },
    });
    const transcript: ModelMessage[] = [
      { role: "assistant", content: "", toolCalls: [call("One"), call("  ")] },
      { role: "assistant", content: "", toolCalls: [call("Two")] },
    ];
    expect(sentTexts(transcript)).toEqual(["One", "Two"]);
    expect(sentTexts(null)).toEqual([]);
  });
});

describe("queueCases", () => {
  it("has the batching and interrupting cases, sent through the real plugin with ids", () => {
    expect(queueCases.map((c) => c.id)).toEqual(["batching", "interrupting"]);
    expect(queueCases[0]!.messages.map((m) => m.text)).toEqual([
      "Plan a dinner.",
      "For 4 people.",
      "Vegetarian.",
    ]);
    expect(queueCases[0]!.messages.slice(1).every((m) => m.afterMs === 200)).toBe(true);
    expect(queueCases[1]!.messages.map((m) => m.text)).toEqual([
      "Book the meeting for Wednesday",
      "Actually, make it Thursday",
    ]);
  });
});
