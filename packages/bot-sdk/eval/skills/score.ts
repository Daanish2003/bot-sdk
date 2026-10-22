// Scores the Skills eval (spec #713, #721) from what a Turn left behind: its tool calls, its Messages
// and the Skills on the Bot's Computer afterwards. Everything here is deterministic; no judge.

import { problemOf } from "../../plugins/skills/server/skills";

/** One tool call of a Turn, in order, with its args (a `run_tool` call already unwrapped). */
export type Call = { name: string; args: unknown };

/** What a run's Turn left behind. */
export type Observed = {
  status: "running" | "complete" | "error" | "stopped";
  calls: Call[];
  /** The text of each Message the Bot sent. */
  sent: string[];
  /** The Bot's Skills after the Turn, by folder name: the text of each `SKILL.md`. */
  skills: Record<string, string>;
  /** The Skills the Computer started with. */
  seeded: string[];
};

/** What a case expects. */
export type Expect =
  /** A message a Skill covers: it reads that Skill, and no other, before its first acting call. */
  | { kind: "use"; skill: string }
  /** A message no Skill covers: it reads none. */
  | { kind: "none" }
  /** An explained repeatable task: a valid Skill is saved whose text matches every pattern, and the Bot says so. */
  | { kind: "save"; mentions: RegExp[] }
  /** A one-off task or a webhook's instructions: no Skill is written. */
  | { kind: "no-save" }
  /** A long task that clearly repeats: saving unasked is measured, not required; a saved one must still be valid. */
  | { kind: "save-unasked" }
  /** A Skill's non-obvious rule shows up in the arguments of the Bot's tool calls. */
  | { kind: "follow"; skill: string; rule: RegExp }
  /** A stale Skill: the Bot edits it (the new text matches `fixed`) and says so. */
  | { kind: "fix"; skill: string; fixed: RegExp };

export type Score = {
  passed: boolean;
  reasons: string[];
  /** For a `use` case: whether the right Skill was read first, and whether a wrong one was read. */
  hit?: boolean;
  wrong?: boolean;
  /** For a `none` case: whether any Skill was read. */
  needless?: boolean;
  /** For a `save-unasked` case: whether the Bot saved a Skill on its own. */
  saved?: boolean;
};

const skillFile = /skills\/([a-z0-9-]+)\/SKILL\.md/;
const readsText = /\b(cat|head|tail|less|more|nl|bat|sed\s+-n|grep)\b/;
const writesText = /((?<![0-9&-])>(?!&|\s*\/dev\/null)|\btee\b|\bsed\s+-i\b|\bmv\b|\bcp\b|\brm\b)/;
/** Tools that look but do not act. */
const lookingTools = new Set(["read", "list", "send_to_user", "describe_tool", "search_memory"]);

const argText = (args: unknown) => (typeof args === "string" ? args : JSON.stringify(args ?? {}));
const field = (args: unknown, key: string): string => {
  const value =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>)[key] : "";
  return typeof value === "string" ? value : "";
};

/** The Skill a `read` call, or a shell command that only reads, opens; undefined for any other call. */
export function skillRead(call: Call): string | undefined {
  if (call.name === "read") return skillFile.exec(field(call.args, "path"))?.[1];
  if (call.name !== "shell") return undefined;
  const command = field(call.args, "command");
  return readsText.test(command) && !writesText.test(command)
    ? skillFile.exec(command)?.[1]
    : undefined;
}

/** Whether `call` does something to the task, not only look (read a Skill, list, or message). */
export function isActing(call: Call): boolean {
  return !lookingTools.has(call.name) && skillRead(call) === undefined;
}

/** The Skills the Turn read, each with the call index of its first read, in that order. */
export function readSkills(calls: Call[]): { name: string; index: number }[] {
  const seen = new Map<string, number>();
  for (const [index, call] of calls.entries()) {
    const name = skillRead(call);
    if (name !== undefined && !seen.has(name)) seen.set(name, index);
  }
  return [...seen].map(([name, index]) => ({ name, index }));
}

/** The Skills the Turn created or changed with `write` or `edit`, by folder name. */
export function writtenSkills(calls: Call[]): string[] {
  const names = new Set<string>();
  for (const call of calls) {
    if (call.name !== "write" && call.name !== "edit") continue;
    const name = skillFile.exec(field(call.args, "path"))?.[1];
    if (name) names.add(name);
  }
  return [...names];
}

const mentionsSkill = (sent: string[]) => sent.some((text) => /\bskill\b/i.test(text));

/** The Skills on the Computer that were not there at the start. */
const newSkills = (observed: Observed) =>
  Object.keys(observed.skills).filter((name) => !observed.seeded.includes(name));

/** Problems with each new Skill's frontmatter, as the Skills block checks it. */
function invalidSkills(observed: Observed): string[] {
  return newSkills(observed).flatMap((name) => {
    const problem = problemOf(name, observed.skills[name]!);
    return problem ? [`Skill ${name} is not usable: ${problem}`] : [];
  });
}

export function scoreSkills(expected: Expect, observed: Observed): Score {
  const reasons: string[] = [];
  if (observed.status !== "complete") {
    reasons.push(`the Turn ended ${observed.status}, not complete`);
  }
  const reads = readSkills(observed.calls);
  const firstActing = observed.calls.findIndex(isActing);
  const finish = (extra: Partial<Score> = {}): Score => ({
    passed: reasons.length === 0,
    reasons,
    ...extra,
  });

  switch (expected.kind) {
    case "use": {
      const right = reads.find((read) => read.name === expected.skill);
      const wrong = reads.some((read) => read.name !== expected.skill);
      const hit = right !== undefined && (firstActing < 0 || right.index < firstActing);
      if (!right) reasons.push(`never read ${expected.skill}`);
      else if (!hit) reasons.push(`read ${expected.skill} only after its first acting call`);
      for (const read of reads) {
        if (read.name !== expected.skill) reasons.push(`also read ${read.name}`);
      }
      return finish({ hit, wrong });
    }
    case "none": {
      for (const read of reads) reasons.push(`needlessly read ${read.name}`);
      return finish({ needless: reads.length > 0 });
    }
    case "save": {
      const names = newSkills(observed);
      if (names.length === 0) reasons.push("no Skill was saved");
      reasons.push(...invalidSkills(observed));
      const all = names.map((name) => observed.skills[name]!).join("\n");
      for (const pattern of expected.mentions) {
        if (names.length > 0 && !pattern.test(all)) {
          reasons.push(`the Skill never mentions ${pattern}`);
        }
      }
      if (!mentionsSkill(observed.sent))
        reasons.push("the Bot never told the user about the Skill");
      return finish();
    }
    case "no-save": {
      for (const name of new Set([...newSkills(observed), ...writtenSkills(observed.calls)])) {
        reasons.push(`a Skill was saved: ${name}`);
      }
      return finish();
    }
    case "save-unasked": {
      const names = newSkills(observed);
      reasons.push(...invalidSkills(observed));
      if (names.length > 0 && !mentionsSkill(observed.sent)) {
        reasons.push("the Bot saved a Skill and never told the user");
      }
      return finish({ saved: names.length > 0 });
    }
    case "follow": {
      const carried = observed.calls.some(
        (call) =>
          !lookingTools.has(call.name) &&
          !skillFile.test(argText(call.args)) &&
          expected.rule.test(argText(call.args)),
      );
      if (!reads.some((read) => read.name === expected.skill)) {
        reasons.push(`never read ${expected.skill}`);
      }
      if (!carried) reasons.push(`no tool call carries the rule ${expected.rule}`);
      return finish();
    }
    case "fix": {
      const named = (call: Call) => skillFile.exec(field(call.args, "path"))?.[1];
      const changes = observed.calls.filter(
        (call) => (call.name === "edit" || call.name === "write") && named(call) === expected.skill,
      );
      if (changes.length === 0) reasons.push(`never edited ${expected.skill}`);
      else {
        const text = changes
          .map((call) => field(call.args, call.name === "edit" ? "newText" : "content"))
          .join("\n");
        if (!expected.fixed.test(text)) reasons.push(`the edit never says ${expected.fixed}`);
      }
      const told = observed.sent.some(
        (text) => /\bskill\b/i.test(text) && /(fix|updat|correct|chang|edit)/i.test(text),
      );
      if (!told) reasons.push("the Bot never told the user it fixed the Skill");
      return finish();
    }
  }
}

/** The rates the run prints: how often the right Skill was read, a wrong one read, a read was needless. */
export function useRates(scores: { expected: Expect; score: Score }[]) {
  const uses = scores.filter(({ expected }) => expected.kind === "use");
  const nones = scores.filter(({ expected }) => expected.kind === "none");
  const count = (list: typeof scores, key: "hit" | "wrong" | "needless") =>
    list.filter(({ score }) => score[key] === true).length;
  const rate = (n: number, of: number) => (of === 0 ? null : n / of);
  return {
    uses: uses.length,
    nones: nones.length,
    hit: rate(count(uses, "hit"), uses.length),
    wrong: rate(count(uses, "wrong"), uses.length),
    needless: rate(count(nones, "needless"), nones.length),
  };
}
