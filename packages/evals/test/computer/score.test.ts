import type { ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { computerCases } from "../../src/computer/cases";
import {
  type Observed,
  observeTools,
  scoreComputerRun,
  tallyComputer,
} from "../../src/computer/score";

const step = (...names: string[]): ModelMessage => ({
  role: "assistant",
  content: "",
  toolCalls: names.map((name, i) => ({
    id: `${name}-${i}`,
    type: "function" as const,
    function: { name, arguments: "{}" },
  })),
});

const observed = (tools: string[], extra: Partial<Observed> = {}): Observed => ({
  status: "complete",
  tools,
  problems: [],
  ...extra,
});

describe("observeTools", () => {
  it("lists the Computer tools called, in order, and ignores the rest", () => {
    const transcript = [step("shell", "send_to_user"), step("read", "write")];
    expect(observeTools(transcript)).toEqual(["shell", "read", "write"]);
  });

  it("reads nothing from a missing transcript", () => {
    expect(observeTools(null)).toEqual([]);
  });
});

describe("scoreComputerRun", () => {
  it("passes a use case that called a Computer tool and left no problems", () => {
    expect(scoreComputerRun("use", observed(["shell"])).passed).toBe(true);
  });

  it("fails a use case that never touched the Computer", () => {
    const score = scoreComputerRun("use", observed([]));
    expect(score.passed).toBe(false);
    expect(score.reasons.join()).toMatch(/never used the Computer/);
  });

  it("fails a use case whose outcome check found a problem", () => {
    const score = scoreComputerRun("use", observed(["write"], { problems: ["no note.txt"] }));
    expect(score).toMatchObject({ passed: false, reasons: ["no note.txt"] });
  });

  it("passes a none case that stayed off the Computer", () => {
    expect(scoreComputerRun("none", observed([])).passed).toBe(true);
  });

  it("fails a none case that called a Computer tool", () => {
    const score = scoreComputerRun("none", observed(["shell", "list"]));
    expect(score.passed).toBe(false);
    expect(score.reasons.join()).toMatch(/shell, list/);
  });

  it("fails a Turn that did not complete", () => {
    expect(scoreComputerRun("none", observed([], { status: "error", error: "boom" })).passed).toBe(
      false,
    );
  });
});

describe("tallyComputer", () => {
  it("reports the rate per case and per group", () => {
    const rates = tallyComputer([
      { caseId: "a", expected: "use", passed: true },
      { caseId: "a", expected: "use", passed: false },
      { caseId: "b", expected: "none", passed: true },
    ]);
    expect(rates.cases.a).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(rates.use).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(rates.none).toEqual({ passed: 1, total: 1, rate: 1 });
  });

  it("has a null rate for a group with no runs", () => {
    expect(tallyComputer([]).use.rate).toBeNull();
  });
});

describe("computerCases", () => {
  it("has unique ids, with use cases and plain-chat cases", () => {
    const ids = computerCases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(computerCases.some((c) => c.expected === "use")).toBe(true);
    expect(computerCases.some((c) => c.expected === "none")).toBe(true);
  });
});
