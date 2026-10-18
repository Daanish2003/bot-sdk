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

const turn = (
  status: QueueObserved["turns"][number]["status"],
  triggerIds: string[],
  sent = 1,
) => ({ status, triggerIds, sent });

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

  it("fails when the Turn completed without sending anything", () => {
    const score = scoreQueue("batching", { triggerIds: ids, turns: [turn("complete", ids, 0)] });
    expect(score.passed).toBe(false);
    expect(score.reasons).toContain("the Turn sent nothing, expected a reply");
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

  it("fails when the Turn that took the correction sent nothing", () => {
    const score = scoreQueue("interrupting", {
      triggerIds: ids,
      turns: [turn("stopped", ["first"], 0), turn("complete", ["fix"], 0)],
    });
    expect(score).toEqual({
      passed: false,
      reasons: ["the last Turn sent nothing, expected a reply"],
    });
  });
});

describe("scoreQueue, unavailable", () => {
  const ids = ["ask"];
  it("passes when one Turn completed and sent a Message", () => {
    expect(scoreQueue("unavailable", { triggerIds: ids, turns: [turn("complete", ids)] })).toEqual({
      passed: true,
      reasons: [],
    });
  });

  it("fails when the Turn answered in plain text and sent nothing", () => {
    const score = scoreQueue("unavailable", { triggerIds: ids, turns: [turn("complete", ids, 0)] });
    expect(score.passed).toBe(false);
    expect(score.reasons).toContain("the Turn sent nothing, expected a reply");
  });

  it("fails when the Turn did not complete", () => {
    const score = scoreQueue("unavailable", { triggerIds: ids, turns: [turn("error", ids)] });
    expect(score.reasons).toContain("the Turn ended error, expected complete");
  });
});

describe("scoreQueue, the other refusal and question cases", () => {
  it.each(["no-email", "unclear", "no-live-data"] as const)(
    "scores %s as one complete Turn that sent a Message",
    (kind) => {
      const ids = ["ask"];
      expect(scoreQueue(kind, { triggerIds: ids, turns: [turn("complete", ids)] }).passed).toBe(
        true,
      );
      expect(
        scoreQueue(kind, { triggerIds: ids, turns: [turn("complete", ids, 0)] }).reasons,
      ).toContain("the Turn sent nothing, expected a reply");
      expect(
        scoreQueue(kind, { triggerIds: ids, turns: [turn("complete", ids), turn("complete", [])] })
          .reasons,
      ).toContain("2 Turns took Triggers, expected exactly 1");
    },
  );
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
  it("has the batching, interrupting and four refusal and question cases, sent through the real plugin with ids", () => {
    expect(queueCases.map((c) => c.id)).toEqual([
      "batching",
      "interrupting",
      "unavailable",
      "no-email",
      "unclear",
      "no-live-data",
    ]);
    expect(queueCases[0]!.messages.map((m) => m.text)).toEqual([
      "Plan a dinner.",
      "For 4 people.",
      "Vegetarian.",
    ]);
    expect(queueCases[0]!.messages.slice(1).every((m) => m.afterMs === 200)).toBe(true);
    expect(queueCases[1]!.messages.map((m) => m.text)).toEqual([
      "Plan a trip to Paris",
      "Actually, make it Rome",
    ]);
    expect(queueCases[1]!.messages[1]!.afterTurnStarts).toBe(true);
    expect(queueCases[2]!.messages.map((m) => m.text)).toEqual(["Book the meeting for Thursday"]);
    expect(queueCases.slice(3).map((c) => c.messages.map((m) => m.text))).toEqual([
      ["Send this summary to my boss"],
      ["Fix it"],
      ["What's the weather in Delhi right now?"],
    ]);
  });
});
