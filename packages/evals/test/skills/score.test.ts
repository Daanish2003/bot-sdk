import { describe, expect, it } from "vitest";

import { fakeObserved, skillLibrary, skillsCases, skillText } from "../../src/skills/cases";
import {
  type Call,
  type Observed,
  readSkills,
  scoreSkills,
  skillRead,
  useRates,
} from "../../src/skills/score";
import { problemOf } from "@botsdk/bot/bot/skill-files";

const read = (name: string): Call => ({ name: "read", args: { path: `skills/${name}/SKILL.md` } });
const shell = (command: string): Call => ({ name: "shell", args: { command } });
const send: Call = { name: "send_to_user", args: { text: "ok" } };

const observed = (calls: Call[], more: Partial<Observed> = {}): Observed => ({
  status: "complete",
  calls,
  sent: ["ok"],
  skills: {},
  seeded: [],
  ...more,
});

describe("the Skills eval's cases", () => {
  it("has the counts of the spec: about 20 use, 15 save and 6 follow and fix", () => {
    const count = (group: string) => skillsCases.filter((c) => c.group === group).length;
    expect(count("use")).toBe(20);
    expect(count("save")).toBe(15);
    expect(count("follow-fix")).toBe(6);
    expect(new Set(skillsCases.map((c) => c.id)).size).toBe(skillsCases.length);
  });

  it("seeds eight usable Skills, in look-alike pairs", () => {
    expect(Object.keys(skillLibrary)).toHaveLength(8);
    for (const [name, text] of Object.entries(skillLibrary)) {
      expect(problemOf(name, text)).toBeNull();
    }
  });

  it("passes every case with the script the dry run plays", () => {
    for (const evalCase of skillsCases) {
      const score = scoreSkills(evalCase.expect, fakeObserved(evalCase));
      expect(score.reasons, evalCase.id).toEqual([]);
    }
  });
});

describe("scoring a Turn's reads", () => {
  it("sees a read tool call and a shell cat as reading a Skill", () => {
    expect(skillRead(read("a-b"))).toBe("a-b");
    expect(skillRead(shell("cat skills/a-b/SKILL.md"))).toBe("a-b");
    expect(skillRead(shell("cat > skills/a-b/SKILL.md <<EOF"))).toBeUndefined();
    expect(skillRead(shell("ls"))).toBeUndefined();
    expect(readSkills([read("a"), shell("echo"), read("b"), read("a")])).toEqual([
      { name: "a", index: 0 },
      { name: "b", index: 2 },
    ]);
  });

  it("hits when the right Skill is read before the first acting call", () => {
    const score = scoreSkills(
      { kind: "use", skill: "a" },
      observed([{ name: "list", args: {} }, read("a"), shell("work"), send]),
    );
    expect(score).toMatchObject({ passed: true, hit: true, wrong: false });
  });

  it("misses when the Skill is read only after acting, or never", () => {
    const late = scoreSkills({ kind: "use", skill: "a" }, observed([shell("work"), read("a")]));
    expect(late).toMatchObject({ passed: false, hit: false });
    const never = scoreSkills({ kind: "use", skill: "a" }, observed([shell("work"), send]));
    expect(never.reasons).toEqual(["never read a"]);
  });

  it("counts a read of the look-alike as a wrong Skill, even beside the right one", () => {
    const score = scoreSkills(
      { kind: "use", skill: "a" },
      observed([read("b"), read("a"), shell("work")]),
    );
    expect(score).toMatchObject({ passed: false, hit: true, wrong: true });
    expect(score.reasons).toEqual(["also read b"]);
  });

  it("fails a read when no Skill fits, as a needless one", () => {
    expect(scoreSkills({ kind: "none" }, observed([send]))).toMatchObject({ passed: true });
    expect(scoreSkills({ kind: "none" }, observed([read("a"), send]))).toMatchObject({
      passed: false,
      needless: true,
    });
  });

  it("fails a Turn that did not complete", () => {
    expect(scoreSkills({ kind: "none" }, observed([], { status: "error" })).passed).toBe(false);
  });

  it("rates hits, wrong Skills and needless reads", () => {
    const hit = scoreSkills({ kind: "use", skill: "a" }, observed([read("a")]));
    const wrong = scoreSkills({ kind: "use", skill: "a" }, observed([read("b")]));
    const needless = scoreSkills({ kind: "none" }, observed([read("a")]));
    const fine = scoreSkills({ kind: "none" }, observed([]));
    expect(
      useRates([
        { expected: { kind: "use", skill: "a" }, score: hit },
        { expected: { kind: "use", skill: "a" }, score: wrong },
        { expected: { kind: "none" }, score: needless },
        { expected: { kind: "none" }, score: fine },
      ]),
    ).toEqual({ uses: 2, nones: 2, hit: 0.5, wrong: 0.5, needless: 0.5 });
  });
});

describe("scoring a save", () => {
  const valid = skillText(
    "new-one",
    "Use this when the user wants a thing",
    "## Steps\n1. Stripe.",
  );

  it("passes a valid new Skill that mentions the task and that the Bot told the user about", () => {
    const score = scoreSkills(
      { kind: "save", mentions: [/stripe/i] },
      observed([], { skills: { "new-one": valid }, sent: ["I saved a Skill for this."] }),
    );
    expect(score.reasons).toEqual([]);
  });

  it("fails an unusable Skill, a Skill that misses the task, and a silent save", () => {
    const bad = scoreSkills(
      { kind: "save", mentions: [/stripe/i] },
      observed([], { skills: { "new-one": "no frontmatter" } }),
    );
    expect(bad.reasons).toContain("Skill new-one is not usable: no frontmatter");
    expect(bad.reasons).toContain("the Bot never told the user about the Skill");
    const off = scoreSkills(
      { kind: "save", mentions: [/paypal/i] },
      observed([], { skills: { "new-one": valid }, sent: ["Skill saved"] }),
    );
    expect(off.reasons).toEqual(["the Skill never mentions /paypal/i"]);
    expect(scoreSkills({ kind: "save", mentions: [] }, observed([])).reasons).toContain(
      "no Skill was saved",
    );
  });

  it("fails a Skill saved from a one-off, whether it landed on the disk or only was written", () => {
    expect(scoreSkills({ kind: "no-save" }, observed([]))).toMatchObject({ passed: true });
    const onDisk = scoreSkills({ kind: "no-save" }, observed([], { skills: { "new-one": valid } }));
    expect(onDisk.reasons).toEqual(["a Skill was saved: new-one"]);
    const written = scoreSkills(
      { kind: "no-save" },
      observed([{ name: "write", args: { path: "skills/x/SKILL.md", content: "" } }]),
    );
    expect(written.reasons).toEqual(["a Skill was saved: x"]);
  });

  it("measures an unasked save without requiring it, but requires it to be valid and announced", () => {
    expect(scoreSkills({ kind: "save-unasked" }, observed([]))).toMatchObject({
      passed: true,
      saved: false,
    });
    const quiet = scoreSkills(
      { kind: "save-unasked" },
      observed([], { skills: { "new-one": valid }, sent: ["Done."] }),
    );
    expect(quiet).toMatchObject({ passed: false, saved: true });
  });
});

describe("scoring follow and fix", () => {
  it("follows when a tool call carries the rule, and not a read of the Skill itself", () => {
    const rule = /reports\/\d{4}-\d{2}\//;
    const followed = scoreSkills(
      { kind: "follow", skill: "a", rule },
      observed([read("a"), { name: "write", args: { path: "reports/2026-10/x.md", content: "" } }]),
    );
    expect(followed.reasons).toEqual([]);
    const ignored = scoreSkills(
      { kind: "follow", skill: "a", rule },
      observed([read("a"), { name: "write", args: { path: "x.md", content: "" } }]),
    );
    expect(ignored.reasons).toEqual([`no tool call carries the rule ${rule}`]);
  });

  it("fixes when the Bot edits the Skill to the new path and says so", () => {
    const edit: Call = {
      name: "edit",
      args: { path: "skills/a/SKILL.md", oldText: "old", newText: "/home/user/new" },
    };
    const fixed = scoreSkills(
      { kind: "fix", skill: "a", fixed: /\/new/ },
      observed([edit], { sent: ["I updated the Skill."] }),
    );
    expect(fixed.reasons).toEqual([]);
    const silent = scoreSkills(
      { kind: "fix", skill: "a", fixed: /\/new/ },
      observed([edit], { sent: ["Done."] }),
    );
    expect(silent.reasons).toEqual(["the Bot never told the user it fixed the Skill"]);
    const none = scoreSkills({ kind: "fix", skill: "a", fixed: /\/new/ }, observed([]));
    expect(none.reasons[0]).toBe("never edited a");
  });
});

describe("scoring reads with redirects", () => {
  it("still sees a read whose stderr is redirected, but not a write to the file", () => {
    expect(skillRead(shell("cat skills/a/SKILL.md 2>&1"))).toBe("a");
    expect(skillRead(shell("cat skills/a/SKILL.md 2>/dev/null"))).toBe("a");
    expect(skillRead(shell("cat skills/a/SKILL.md > copy.md"))).toBeUndefined();
  });
});
