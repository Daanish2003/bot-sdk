import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { routineCases } from "../../../eval/turn/routine-cases";
import {
  callInputs,
  callNames,
  callsToJudge,
  describeCall,
  failEmptyJudgement,
  nextThursday,
  scoreRoutine,
  toolCallsOf,
  turnIdOf,
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

const now = new Date("2026-10-19T10:00:00Z");

describe("callInputs and describeCall", () => {
  it("gives the judge the current time, the zone, and whether at is in the past", () => {
    const past = describeCall(
      "set_check_in",
      { at: "2026-10-15T09:00:00Z", note: "n" },
      now,
      "UTC",
    );
    expect(past).toContain("2026-10-19T10:00:00.000Z");
    expect(past).toContain("UTC");
    expect(past).toContain("in the past");
    const future = describeCall(
      "set_check_in",
      { at: "2026-10-22T09:00:00Z", note: "n" },
      now,
      "UTC",
    );
    expect(future).toContain("in the future");
  });

  it("gives a fake Check-in a future Thursday", () => {
    const at = nextThursday(now);
    expect(at.getTime()).toBeGreaterThan(now.getTime());
    expect(at.getUTCDay()).toBe(4);
  });

  it("reads the input of each call of a tool", () => {
    expect(callInputs(calls("create_routine", "send_to_user"), "create_routine")).toEqual([
      { name: "x", at: "2026-10-22T09:00:00+01:00" },
    ]);
  });

  it("names the weekday of a check-in's local date", () => {
    const text = describeCall(
      "set_check_in",
      { at: "2026-10-22T09:00:00+01:00", note: "n" },
      now,
      "UTC",
    );
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

describe("failEmptyJudgement", () => {
  it("fails a judged case whose judged text is empty, with a reason", () => {
    const score = failEmptyJudgement({ passed: true, reasons: [] }, "  ", "create_routine");
    expect(score).toEqual({
      passed: false,
      reasons: ["nothing to judge: no create_routine input"],
    });
  });

  it("leaves the score alone when there is text to judge", () => {
    const score = { passed: true, reasons: [] };
    expect(failEmptyJudgement(score, "text", "reply")).toBe(score);
  });
});

describe("toolCallsOf", () => {
  it("lists each call with its name and parsed args, keeping unparsable args as text", () => {
    const transcript: ModelMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "a",
            type: "function",
            function: { name: "set_check_in", arguments: '{"note":"n"}' },
          },
          { id: "b", type: "function", function: { name: "create_routine", arguments: "{oops" } },
        ],
      },
    ];
    expect(toolCallsOf(transcript)).toEqual([
      { name: "set_check_in", args: { note: "n" } },
      { name: "create_routine", args: "{oops" },
    ]);
    expect(toolCallsOf(null)).toEqual([]);
  });
});

describe("describeCall weekday", () => {
  it("reads the weekday in the user's zone, not from the date prefix of an offset", () => {
    const at = "2026-10-22T23:30:00-05:00";
    expect(describeCall("set_check_in", { at, note: "n" }, now, "UTC")).toContain("a Friday");
    expect(describeCall("set_check_in", { at, note: "n" }, now, "America/Chicago")).toContain(
      "a Thursday",
    );
  });

  it("says when at has no offset", () => {
    const text = describeCall("set_check_in", { at: "2026-10-22T09:00:00", note: "n" }, now, "UTC");
    expect(text).toContain("no offset");
  });
});

const turnWith = (tool: string, input: unknown, result: unknown): ModelMessage[] => [
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "t1", type: "function", function: { name: tool, arguments: JSON.stringify(input) } },
    ],
  },
  { role: "tool", toolCallId: "t1", content: JSON.stringify(result) },
];

describe("callsToJudge", () => {
  const input = { at: "2026-10-22T09:00:00Z", note: "n" };

  it("describes a call the tool accepted", () => {
    const out = callsToJudge(
      turnWith("set_check_in", input, { saved: { id: "x" } }),
      "set_check_in",
      now,
      "UTC",
    );
    expect(out.text).toContain("set_check_in");
    expect(out.rejection).toBeUndefined();
  });

  it("does not judge a call the tool rejected, and says why", () => {
    const out = callsToJudge(
      turnWith("set_check_in", input, { error: "Not saved: too soon" }),
      "set_check_in",
      now,
      "UTC",
    );
    expect(out.text).toBe("");
    expect(out.rejection).toBe("set_check_in was rejected: Not saved: too soon");
  });

  it("does not judge a call with no result", () => {
    const transcript = turnWith("set_check_in", input, {}).slice(0, 1);
    expect(callsToJudge(transcript, "set_check_in", now, "UTC").rejection).toBe(
      "set_check_in has no result",
    );
  });

  it("judges an accepted retry after a rejection", () => {
    const retry = turnWith("set_check_in", input, { saved: {} }).map((m) => ({
      ...m,
      toolCallId: m.role === "tool" ? "t2" : undefined,
      toolCalls: m.toolCalls?.map((c) => ({ ...c, id: "t2" })),
    }));
    const transcript = [
      ...turnWith("set_check_in", input, { error: "no" }),
      ...retry,
    ] as ModelMessage[];
    const out = callsToJudge(transcript, "set_check_in", now, "UTC");
    expect(out.text).toContain("set_check_in");
    expect(out.rejection).toBeUndefined();
  });

  it("judges a call made through run_tool as the tool it names", () => {
    const transcript = turnWith(
      "run_tool",
      { name: "create_routine", args: { name: "Digest", schedule: "daily" } },
      { saved: { id: "x" } },
    );
    const out = callsToJudge(transcript, "create_routine", now, "UTC");
    expect(out.text).toBe('create_routine {"name":"Digest","schedule":"daily"}');
    expect(out.rejection).toBeUndefined();
  });
});

describe("turnIdOf", () => {
  it("returns the Turn that took the Trigger", () => {
    expect(turnIdOf({ takenBy: "turn-1" })).toBe("turn-1");
  });

  it("throws when the Trigger waits for a running Turn", () => {
    expect(() => turnIdOf({ waitsFor: "turn-0" })).toThrow(/waits for/);
  });
});

describe("a call through run_tool", () => {
  const wrapped: ModelMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "c0",
          type: "function",
          function: {
            name: "run_tool",
            arguments: JSON.stringify({ name: "create_routine", args: { name: "brief" } }),
          },
        },
      ],
    },
  ];

  it("counts as the tool it names", () => {
    expect(callNames(wrapped)).toEqual(["create_routine"]);
    expect(callInputs(wrapped, "create_routine")).toEqual([{ name: "brief" }]);
    expect(toolCallsOf(wrapped)).toEqual([{ name: "create_routine", args: { name: "brief" } }]);
  });
});
