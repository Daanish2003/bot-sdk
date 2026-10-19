import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { routineCases } from "../../../eval/turn/routine-cases";
import {
  callInputs,
  describeCall,
  scoreRoutine,
  type RoutineObserved,
} from "../../../eval/turn/routine-score";

const calls = (...names: string[]): ModelMessage[] => [
  {
    role: "assistant",
    content: "",
    toolCalls: names.map((name, i) => ({
      id: `c${i}`,
      type: "function" as const,
      function: { name, arguments: JSON.stringify({ name: "x", at: "2026-10-22T09:00:00+01:00" }) },
    })),
  },
];

const observed = (over: Partial<RoutineObserved> = {}): RoutineObserved => ({
  status: "complete",
  calls: [],
  sent: 1,
  ...over,
});

describe("scoreRoutine", () => {
  it("passes a create_routine call when one was wanted, and fails its absence", () => {
    const wanted = { createRoutine: true };
    expect(scoreRoutine(wanted, observed({ calls: ["create_routine"] })).passed).toBe(true);
    expect(scoreRoutine(wanted, observed()).reasons).toEqual(["create_routine was not called"]);
  });

  it("fails a create_routine call that was not wanted", () => {
    const score = scoreRoutine({ createRoutine: false }, observed({ calls: ["create_routine"] }));
    expect(score.reasons).toEqual(["create_routine was called, expected no call"]);
  });

  it("wants set_check_in and no create_routine for a check back", () => {
    const wanted = { setCheckIn: true, createRoutine: false };
    expect(scoreRoutine(wanted, observed({ calls: ["set_check_in"] })).passed).toBe(true);
    expect(scoreRoutine(wanted, observed({ calls: ["create_routine"] })).passed).toBe(false);
  });

  it("passes a quiet run only with no Message", () => {
    expect(scoreRoutine({ sent: "none" }, observed({ sent: 0 })).passed).toBe(true);
    expect(scoreRoutine({ sent: "none" }, observed({ sent: 1 })).reasons).toEqual([
      "sent 1 Message(s), expected none",
    ]);
  });

  it("wants exactly one Message for `one`, and at least one for `some`", () => {
    expect(scoreRoutine({ sent: "one" }, observed({ sent: 2 })).passed).toBe(false);
    expect(scoreRoutine({ sent: "one" }, observed({ sent: 1 })).passed).toBe(true);
    expect(scoreRoutine({ sent: "some" }, observed({ sent: 0 })).passed).toBe(false);
    expect(scoreRoutine({ sent: "some" }, observed({ sent: 3 })).passed).toBe(true);
  });

  it("fails a Turn that did not complete", () => {
    const score = scoreRoutine({}, observed({ status: "error" }));
    expect(score.reasons).toEqual(["the Turn ended error, expected complete"]);
  });
});

describe("callInputs and describeCall", () => {
  it("reads the input of each call of a tool", () => {
    expect(callInputs(calls("create_routine", "send_to_user"), "create_routine")).toEqual([
      { name: "x", at: "2026-10-22T09:00:00+01:00" },
    ]);
  });

  it("names the weekday of a check-in's local date", () => {
    const text = describeCall("set_check_in", { at: "2026-10-22T09:00:00+01:00", note: "n" });
    expect(text).toContain("Thursday");
  });
});

describe("routineCases", () => {
  it("has one case for each acceptance criterion, with unique ids", () => {
    expect(new Set(routineCases.map((c) => c.id)).size).toBe(routineCases.length);
    expect(routineCases.map((c) => c.id)).toEqual([
      "routine-recurring",
      "routine-one-off",
      "routine-check-back",
      "routine-run-nothing-new",
      "routine-run-something-new",
      "check-in-fired",
    ]);
  });
});
