import { describe, expect, it } from "vitest";

import { defaultRoutinePrompts, proactiveCases, type Step } from "../../src/proactive/cases";
import { type Call, costOf, scoreProactive } from "../../src/proactive/score";

const context = { notesPath: "/home/user/bots/b/memory/notes.md", today: "2026-10-30" };

/** A script's calls as a Turn's transcript gives them: a `run_tool` call is the tool it names. */
const callsOf = (steps: Step[]): Call[] =>
  steps.map((step) =>
    step.name === "run_tool"
      ? { name: String(step.input.name), args: step.input.args }
      : { name: step.name, args: step.input },
  );

/** The Routines a script saves, as the `bot_routine` rows would hold them (pending). */
const routinesOf = (calls: Call[]) =>
  calls
    .filter((call) => call.name === "create_routine")
    .map((call) => {
      const args = call.args as Record<string, unknown>;
      return {
        name: String(args.name),
        state: "pending",
        readOnly: args.readOnly === true,
        schedule: args.schedule,
      };
    });

describe("the Proactive eval's cases", () => {
  it("has six gating cases with unique ids", () => {
    expect(proactiveCases).toHaveLength(6);
    expect(proactiveCases.every((c) => c.gating)).toBe(true);
    expect(new Set(proactiveCases.map((c) => c.id)).size).toBe(proactiveCases.length);
  });

  it("reads the SDK's own default prompts", () => {
    expect(defaultRoutinePrompts.brief).toMatch(/^Review the user's Connections/);
    expect(defaultRoutinePrompts.watch).toMatch(/^Check the user's Connections/);
  });

  it("passes every Turn with its good script and fails it with its broken one", () => {
    for (const evalCase of proactiveCases) {
      for (const turn of evalCase.turns) {
        const watch = turn.start.kind === "watch";
        const observe = (steps: Step[]) => {
          const calls = callsOf(steps);
          return { status: "complete" as const, calls, routines: routinesOf(calls) };
        };
        expect(
          scoreProactive(turn.expect, observe(turn.good(context)), { watch }).reasons,
          evalCase.id,
        ).toEqual([]);
        expect(
          scoreProactive(turn.expect, observe(turn.broken(context)), { watch }).passed,
          `${evalCase.id} (broken)`,
        ).toBe(false);
      }
    }
  });
});

describe("scoreProactive", () => {
  const send = (args: Record<string, unknown>): Call => ({ name: "send_to_user", args });

  it("reads a curly apostrophe in a Message the same as a straight one", () => {
    const score = scoreProactive(
      { kind: "urgent", item: /can't pay/i },
      { status: "complete", calls: [send({ text: "Customers can’t pay.", urgent: true })] },
    );
    expect(score.passed).toBe(true);
  });

  it("fails an urgent item sent without the urgent mark", () => {
    const score = scoreProactive(
      { kind: "urgent", item: /payments/i },
      { status: "complete", calls: [send({ text: "Payments are failing." })] },
    );
    expect(score.reasons).toEqual(["sent the urgent item but didn't mark it urgent"]);
  });

  it("fails a Watch that retries a refused write after the first refusal", () => {
    const write: Call = { name: "mail_send_email", args: { to: "a@b.c" } };
    const score = scoreProactive(
      { kind: "draft", item: /priya/i },
      {
        status: "complete",
        calls: [write, write, send({ text: "Priya", choice: { options: ["Yes", "No"] } })],
      },
    );
    expect(score.passed).toBe(false);
    expect(score.reasons[0]).toMatch(/kept trying/);
  });

  it("passes a draft after one refused attempt, and fails a draft with no choice", () => {
    const write: Call = { name: "mail_send_email", args: { to: "a@b.c" } };
    const draft = send({ text: "Priya asks. Draft: yes.", choice: { options: ["Send", "Skip"] } });
    expect(
      scoreProactive(
        { kind: "draft", item: /priya/i },
        { status: "complete", calls: [write, draft] },
      ).passed,
    ).toBe(true);
    expect(
      scoreProactive(
        { kind: "draft", item: /priya/i },
        { status: "complete", calls: [send({ text: "Priya asks." })] },
      ).reasons,
    ).toEqual(["sent no draft about the item with a choice"]);
  });

  it("counts an edit of notes.md as a Note, and any other file as none", () => {
    const edit = (path: string): Call => ({
      name: "edit",
      args: { path, oldText: "", newText: "- 2026-10-30 Lena's deck" },
    });
    const note = (path: string) =>
      scoreProactive({ kind: "note", item: /lena/i }, { status: "complete", calls: [edit(path)] });
    expect(note("/x/memory/notes.md").passed).toBe(true);
    expect(note("/x/memory/log/2026-10.md").reasons).toEqual(["saved no Note about the item"]);
  });

  it("fails a first Bot whose Watch isn't read-only or whose Routines are active", () => {
    const calls = callsOf(
      proactiveCases.find((c) => c.id === "first-offers")!.turns[0]!.good(context),
    );
    const saved = routinesOf(calls);
    const offers = (routines: typeof saved) =>
      scoreProactive({ kind: "offers" }, { status: "complete", calls, routines }, { watch: false });
    expect(offers(saved).reasons).toEqual([]);
    expect(offers(saved.map((r) => ({ ...r, readOnly: false }))).passed).toBe(false);
    expect(offers(saved.map((r) => ({ ...r, state: "active" }))).passed).toBe(false);
  });
});

describe("costOf", () => {
  it("prices the cached tokens apart from the fresh input, and sums the recorded cost", () => {
    const cost = costOf(
      [
        {
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 8_000,
          cacheWriteTokens: 0,
          costMicros: 130_000,
        },
        {
          inputTokens: 2_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 2_000,
          costMicros: 0,
        },
      ],
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    );
    expect(cost).toMatchObject({ rows: 2, inputTokens: 12_000, recordedUsd: 0.13 });
    // 2000 fresh x 3 + 1000 out x 15 + 8000 read x 0.3 + 2000 written x 3.75, per million.
    expect(cost.listUsd).toBeCloseTo((6_000 + 15_000 + 2_400 + 7_500) / 1_000_000, 10);
  });
});
