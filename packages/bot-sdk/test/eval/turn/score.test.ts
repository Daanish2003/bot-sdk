import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { turnCases } from "../../../eval/turn/cases";
import { type Observed, observeTranscript, scoreTurn, tally } from "../../../eval/turn/score";

const call = (
  text: string,
  endTurn: boolean,
  id = text,
): NonNullable<ModelMessage["toolCalls"]> => [
  {
    id,
    type: "function",
    function: { name: "send_to_user", arguments: JSON.stringify({ text, endTurn }) },
  },
];
const step = (...calls: NonNullable<ModelMessage["toolCalls"]>[]): ModelMessage => ({
  role: "assistant",
  content: "",
  toolCalls: calls.flat(),
});

const sent = (...endTurns: boolean[]): Observed => ({
  status: "complete",
  messages: endTurns.length,
  sends: endTurns.map((endTurn) => ({ endTurn })),
  callsAfterLastSend: 0,
});

describe("scoreTurn", () => {
  it("passes a reply case with one Message and endTurn on it", () => {
    expect(scoreTurn({ expected: "reply" }, sent(true))).toMatchObject({
      passed: true,
      endTurn: true,
    });
  });

  it("fails a reply case that sent nothing, and has no endTurn verdict", () => {
    const score = scoreTurn({ expected: "reply" }, sent());
    expect(score).toMatchObject({ passed: false, endTurn: null });
    expect(score.reasons[0]).toMatch(/sent 0 Message/);
  });

  it("fails a reply whose last send did not set endTurn", () => {
    const score = scoreTurn({ expected: "reply" }, sent(false));
    expect(score).toMatchObject({ passed: false, endTurn: false });
    expect(score.reasons).toContain("the last send did not set endTurn");
  });

  it("fails a reply with a model call after the last send", () => {
    const score = scoreTurn({ expected: "reply" }, { ...sent(true), callsAfterLastSend: 1 });
    expect(score).toMatchObject({ passed: false, endTurn: false });
    expect(score.reasons).toContain("the Model was called after the last send");
  });

  it("needs two Messages and endTurn only on the last for a multi-message case", () => {
    expect(scoreTurn({ expected: "reply", multi: true }, sent(false, true)).passed).toBe(true);
    expect(scoreTurn({ expected: "reply", multi: true }, sent(true)).passed).toBe(false);
    const early = scoreTurn({ expected: "reply", multi: true }, sent(true, true));
    expect(early.passed).toBe(false);
    expect(early.reasons).toContain("an earlier send set endTurn");
  });

  it("fails a reply case whose Turn did not complete, with the error", () => {
    const score = scoreTurn(
      { expected: "reply" },
      { ...sent(true), status: "error", error: "boom" },
    );
    expect(score.passed).toBe(false);
    expect(score.reasons).toContain("the Turn ended error: boom");
  });

  it("passes a quiet case with no Messages and a complete Turn", () => {
    expect(scoreTurn({ expected: "quiet" }, sent())).toMatchObject({ passed: true, endTurn: null });
  });

  it("fails a quiet case that sent a Message, or did not complete", () => {
    expect(scoreTurn({ expected: "quiet" }, sent(true)).passed).toBe(false);
    expect(scoreTurn({ expected: "quiet" }, { ...sent(), status: "stopped" }).passed).toBe(false);
  });
});

describe("observeTranscript", () => {
  it("reads the sends and finds no later model call when the last Step sent", () => {
    const transcript: ModelMessage[] = [
      step(call("One", false), call("Two", true)),
      { role: "tool", toolCallId: "One", content: "{}" },
    ];
    expect(observeTranscript(transcript)).toEqual({
      sends: [{ endTurn: false }, { endTurn: true }],
      callsAfterLastSend: 0,
    });
  });

  it("counts the model calls after the last send", () => {
    const transcript: ModelMessage[] = [
      step(call("Hi", false)),
      step(),
      { role: "assistant", content: "done" },
    ];
    expect(observeTranscript(transcript)).toMatchObject({ callsAfterLastSend: 2 });
  });

  it("ignores an empty send and other tools, and reads a missing transcript as no sends", () => {
    const other: NonNullable<ModelMessage["toolCalls"]> = [
      { id: "x", type: "function", function: { name: "other", arguments: "{}" } },
    ];
    expect(observeTranscript([step(call("  ", true), other)])).toEqual({
      sends: [],
      callsAfterLastSend: 0,
    });
    expect(observeTranscript(null)).toEqual({ sends: [], callsAfterLastSend: 0 });
  });
});

describe("tally", () => {
  it("rates the reply, quiet and endTurn groups", () => {
    const scores = [
      scoreTurn({ expected: "reply" }, sent(true)),
      scoreTurn({ expected: "reply" }, sent(false)),
      scoreTurn({ expected: "reply" }, sent()),
      scoreTurn({ expected: "quiet" }, sent()),
    ];
    expect(tally(scores)).toEqual({
      reply: { passed: 1, total: 3, rate: 1 / 3 },
      quiet: { passed: 1, total: 1, rate: 1 },
      endTurn: { passed: 1, total: 2, rate: 0.5 },
    });
  });

  it("gives no rate for an empty group", () => {
    expect(tally([]).quiet).toEqual({ passed: 0, total: 0, rate: null });
  });
});

describe("turnCases", () => {
  const replies = turnCases.filter((c) => c.expected === "reply");
  const quiets = turnCases.filter((c) => c.expected === "quiet");

  it("has about ten reply and ten quiet cases, one or two asking for several Messages", () => {
    expect(replies).toHaveLength(10);
    expect(quiets).toHaveLength(10);
    expect(replies.filter((c) => c.multi).length).toBeGreaterThanOrEqual(1);
    expect(replies.filter((c) => c.multi).length).toBeLessThanOrEqual(2);
  });

  it("has unique ids and non-empty messages", () => {
    expect(new Set(turnCases.map((c) => c.id)).size).toBe(turnCases.length);
    for (const c of turnCases) expect(c.message.trim()).not.toBe("");
  });

  it("follows a Bot answer in every quiet case, and leaves multi to reply cases", () => {
    for (const c of quiets) {
      expect(c.history.at(-1)?.bot.length, c.id).toBeGreaterThan(0);
      expect(c.multi, c.id).toBeUndefined();
    }
  });
});
