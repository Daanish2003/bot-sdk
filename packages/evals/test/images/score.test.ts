import { describe, expect, it } from "vitest";

import { imagesCases } from "../../src/images/cases";
import { type Call, scoreImages } from "../../src/images/score";

const caseOf = (id: string) => imagesCases.find((c) => c.id === id)!;
const callsOf = (steps: { name: string; input: Record<string, unknown> }[]): Call[] =>
  steps.map((step) => ({
    name: step.name === "run_tool" ? String(step.input.name) : step.name,
    args: step.name === "run_tool" ? step.input.args : step.input,
  }));
const score = (id: string, calls: Call[], status: "complete" | "error" = "complete") =>
  scoreImages(caseOf(id).expect, { status, calls });
const draw = (args: Record<string, unknown>): Call => ({ name: "generate_image", args });
const send = (args: Record<string, unknown>): Call => ({ name: "send_to_user", args });

describe("the Images eval's cases", () => {
  it("has five cases with unique ids", () => {
    expect(imagesCases).toHaveLength(5);
    expect(new Set(imagesCases.map((c) => c.id)).size).toBe(5);
  });

  it("passes every case with its good script and fails it with its broken one", () => {
    for (const evalCase of imagesCases) {
      const observed = (steps: typeof evalCase.good) => ({
        status: "complete" as const,
        calls: callsOf(steps),
      });
      expect(scoreImages(evalCase.expect, observed(evalCase.good)).reasons, evalCase.id).toEqual(
        [],
      );
      expect(scoreImages(evalCase.expect, observed(evalCase.broken)).passed, evalCase.id).toBe(
        false,
      );
    }
  });
});

describe("scoring", () => {
  it("needs the image sent after it is made, in the same Turn", () => {
    const files = { text: "Here", files: ["images/a.png"] };
    expect(score("generate-bicycle", [draw({ prompt: "a bike" }), send(files)]).passed).toBe(true);
    expect(score("generate-bicycle", [send(files), draw({ prompt: "a bike" })]).passed).toBe(false);
    expect(score("generate-bicycle", [draw({ prompt: "a bike" })]).passed).toBe(false);
    expect(
      score("generate-bicycle", [
        draw({ prompt: "a bike" }),
        send({ text: "Done", files: ["notes.txt"] }),
      ]).passed,
    ).toBe(false);
  });

  it("fails a drawing nobody asked for", () => {
    expect(
      score("no-image-formats", [
        draw({ prompt: "png" }),
        send({ text: "x", files: ["images/a.png"] }),
      ]).passed,
    ).toBe(false);
    expect(score("no-image-formats", [send({ text: "PNG is lossless." })]).passed).toBe(true);
    expect(score("no-image-formats", []).passed).toBe(false);
  });

  it("needs the earlier file in editPaths", () => {
    const files = { text: "Done", files: ["images/new.png"] };
    expect(
      score("edit-earlier", [
        draw({ prompt: "night", editPaths: ["/home/user/bots/b/images/lighthouse.png"] }),
        send(files),
      ]).passed,
    ).toBe(true);
    expect(score("edit-earlier", [draw({ prompt: "night" }), send(files)]).passed).toBe(false);
    expect(
      score("edit-earlier", [
        draw({ prompt: "night", editPaths: ["images/other.png"] }),
        send(files),
      ]).passed,
    ).toBe(false);
  });

  it("fails a Turn that errored", () => {
    expect(score("no-image-formats", [send({ text: "PNG" })], "error").passed).toBe(false);
  });
});
