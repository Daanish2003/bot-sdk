import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { ladderCases } from "../../src/turn/ladder-cases";
import { helperStarts, type LadderObserved, scoreLadder } from "../../src/turn/ladder-score";

const observed = (over: Partial<LadderObserved> = {}): LadderObserved => ({
  status: "complete",
  helperTypes: [],
  sent: 1,
  ...over,
});

describe("scoreLadder", () => {
  it("passes no start_helper call when none was wanted, and fails any", () => {
    const wanted = { helpers: "none", sent: "some" } as const;
    expect(scoreLadder(wanted, observed()).passed).toBe(true);
    expect(scoreLadder(wanted, observed({ helperTypes: ["general"] })).reasons).toEqual([
      "start_helper was called 1 time(s), expected no call",
    ]);
  });

  it("wants exactly one Helper of the right type", () => {
    const wanted = { helpers: "general", sent: "some" } as const;
    expect(scoreLadder(wanted, observed({ helperTypes: ["general"] })).passed).toBe(true);
    expect(scoreLadder(wanted, observed()).reasons).toEqual([
      "start_helper was called 0 time(s), expected 1",
    ]);
    expect(scoreLadder(wanted, observed({ helperTypes: ["general", "general"] })).passed).toBe(
      false,
    );
    expect(scoreLadder(wanted, observed({ helperTypes: ["computer_use"] })).reasons).toEqual([
      "start_helper started a computer_use Helper, expected general",
    ]);
  });

  it("never allows a Computer-use Helper when the tool is broken, whatever else it does", () => {
    const wanted = { helpers: "not-computer-use", sent: "some" } as const;
    expect(scoreLadder(wanted, observed()).passed).toBe(true);
    expect(scoreLadder(wanted, observed({ helperTypes: ["general"] })).passed).toBe(true);
    expect(scoreLadder(wanted, observed({ helperTypes: ["computer_use"] })).passed).toBe(false);
  });

  it("counts Messages and the Turn's ending", () => {
    expect(scoreLadder({ helpers: "none", sent: "one" }, observed({ sent: 2 })).reasons).toEqual([
      "sent 2 Message(s), expected 1",
    ]);
    expect(scoreLadder({ helpers: "none", sent: "some" }, observed({ sent: 0 })).reasons).toEqual([
      "sent no Message, expected at least 1",
    ]);
    expect(
      scoreLadder({ helpers: "none", sent: "some" }, observed({ status: "error" })).reasons,
    ).toEqual(["the Turn ended error, expected complete"]);
  });
});

describe("helperStarts", () => {
  it("reads the type and task of each start_helper call and skips other calls", () => {
    const transcript: ModelMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "a",
            type: "function",
            function: { name: "start_helper", arguments: '{"type":"general","task":"Do it."}' },
          },
          {
            id: "b",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"x"}' },
          },
        ],
      },
    ];
    expect(helperStarts(transcript)).toEqual([{ type: "general", task: "Do it." }]);
    expect(helperStarts(null)).toEqual([]);
  });
});

describe("ladderCases", () => {
  it("each pass the structural score with their own fake script", () => {
    for (const evalCase of ladderCases) {
      const helperTypes = evalCase.fake.calls
        .filter((call) => call.name === "start_helper")
        .map((call) => String(call.input.type));
      expect(scoreLadder(evalCase.expect, observed({ helperTypes })).passed, evalCase.id).toBe(
        true,
      );
    }
  });

  it("cover the five behaviours of the ladder, with unique ids", () => {
    expect(ladderCases.map((c) => c.id)).toEqual([
      "quick-question",
      "research-task",
      "website-task",
      "helper-report",
      "broken-tool",
    ]);
  });
});
