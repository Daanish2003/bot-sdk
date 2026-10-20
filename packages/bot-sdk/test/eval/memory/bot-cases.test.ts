import { describe, expect, it } from "vitest";

import { botMemoryCases, changedFiles, linesIn, linesOf } from "../../../eval/memory/bot-cases";

describe("the Bot memory eval's cases", () => {
  it("has the 8 cases of the spec, with unique ids", () => {
    expect(botMemoryCases).toHaveLength(8);
    expect(new Set(botMemoryCases.map((evalCase) => evalCase.id)).size).toBe(8);
  });

  it("has a fake Turn script for every Turn", () => {
    for (const evalCase of botMemoryCases) {
      expect(evalCase.fake).toHaveLength(evalCase.turns.length);
    }
  });

  it("reads lines without markers, headings or blanks", () => {
    expect(linesOf("# Profile\n\n- Is vegan\n* Lives in Rome\n")).toEqual([
      "Is vegan",
      "Lives in Rome",
    ]);
    expect(linesOf(undefined)).toEqual([]);
  });

  it("collects the lines of the files matching a path", () => {
    const files = { "profile.md": "- A\n", "log/2026-10.md": "- B\n", "notes.md": "- C\n" };
    expect(linesIn(files, /^log\//)).toEqual(["B"]);
  });

  it("names the files that differ", () => {
    expect(
      changedFiles({ "a.md": "x", "b.md": "y" }, { "a.md": "x", "b.md": "z", "c.md": "w" }),
    ).toEqual(["b.md", "c.md"]);
  });

  it("fails the small-talk case when a file changes", async () => {
    const evalCase = botMemoryCases.find((c) => c.id === "small-talk-nothing")!;
    const ask = async () => false;
    const same = { "profile.md": "- Prefers short replies\n" };
    expect(await evalCase.check({ sent: [], files: [same], ask }, "2026-10-20")).toEqual([]);
    const problems = await evalCase.check(
      { sent: [], files: [{ ...same, "notes.md": "- 2026-10-20 Said thanks\n" }], ask },
      "2026-10-20",
    );
    expect(problems).toEqual(["memory files changed: notes.md"]);
  });
});
