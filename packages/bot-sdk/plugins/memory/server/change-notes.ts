import type { FeatureCall, FeatureEarlierTurn } from "../../../core/server/feature";

/*
 * The Change notes of the memory block (slide 31, ADR 0022 amended): the Prompt start freezes the
 * block, so a Turn tells the Bot which lines were added or removed since, comparing what it has
 * seen (the block as built, the notes its Turns were told, and what it wrote itself) with the
 * block now.
 */

type Tier = "profile" | "log" | "notes";
const tiers: Tier[] = ["profile", "log", "notes"];
const tierHeading: Record<string, Tier> = { Profile: "profile", Log: "log", Notes: "notes" };
const tierLabel: Record<Tier, string> = { profile: "Profile", log: "Log", notes: "Notes" };

type MemoryLines = Record<Tier, string[]>;

/** The lines of a memory block, by tier. */
function memoryLinesOf(block: string): MemoryLines {
  const lines: MemoryLines = { profile: [], log: [], notes: [] };
  let tier: Tier | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("## ")) tier = tierHeading[line.slice(3)];
    else if (tier && line.startsWith("- ")) lines[tier].push(line.slice(2));
  }
  return lines;
}

/** The text lines of a memory file's content, without their `- ` marker. */
function fileLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((raw) =>
      raw
        .trim()
        .replace(/^[-*]\s+/, "")
        .trim(),
    )
    .filter((text) => text !== "" && !text.startsWith("#"));
}

const memoryFile = /(?:^|\/)memory\/(?:(profile|notes)\.md|log\/(\d{4}-\d{2})\.md)$/;

/** Which of the Bot's memory files `path` is: its tier and, for a Log, its month. */
function memoryTarget(botId: string, path: string): { tier: Tier; month?: string } | undefined {
  if (path.includes("/bots/") && !path.includes(`/bots/${botId}/`)) return undefined;
  const match = memoryFile.exec(path);
  if (!match) return undefined;
  return match[1] ? { tier: match[1] as Tier } : { tier: "log", month: match[2] };
}

const removeOne = (lines: string[], text: string) => {
  const at = lines.indexOf(text);
  if (at >= 0) lines.splice(at, 1);
};

/** Applies the lines of an earlier Turn's Change notes to `seen`: the Bot was told them. */
function applyNotes(seen: MemoryLines, notes: readonly string[]) {
  for (const note of notes) {
    const memory = /^Memory (added|removed) \((Profile|Log|Notes)\): (.*)$/.exec(note);
    if (!memory) continue;
    const lines = seen[tierHeading[memory[2]!]!];
    if (memory[1] === "added") lines.push(memory[3]!);
    else removeOne(lines, memory[3]!);
  }
}

/**
 * Applies the Bot's own memory writes in an earlier Turn to `seen`: it knows what it did, so it
 * gets no note for it. Only its `write` and `edit` calls count, not a shell command.
 */
function applyOwnCalls(botId: string, seen: MemoryLines, calls: readonly FeatureCall[]) {
  for (const { name, args } of calls) {
    if (name !== "write" && name !== "edit") continue;
    const target = typeof args.path === "string" ? memoryTarget(botId, args.path) : undefined;
    if (!target) continue;
    const lines = seen[target.tier];
    if (name === "write" && typeof args.content === "string") {
      // The file is replaced whole: its own lines in `seen` go, and what it holds now is seen.
      const own = (line: string) =>
        target.tier === "profile"
          ? !line.startsWith("[")
          : target.tier === "log"
            ? line.startsWith(`${target.month}-`)
            : true;
      seen[target.tier] = [...lines.filter((line) => !own(line)), ...fileLines(args.content)];
    } else if (typeof args.oldText === "string" && typeof args.newText === "string") {
      const { oldText, newText } = args;
      if (oldText.includes("\n")) {
        const before = fileLines(oldText);
        const after = fileLines(newText);
        for (const line of before.filter((line) => !after.includes(line))) removeOne(lines, line);
        lines.push(...after.filter((line) => !before.includes(line)));
      } else if (oldText !== "") {
        const at = lines.findIndex((line) => line.includes(oldText));
        if (at >= 0) lines[at] = lines[at]!.replace(oldText, newText);
      }
    }
  }
}

/**
 * The Change notes for Bot `botId`'s memory block `current`, given the block as its Prompt start
 * holds it (`built`, null when it has none) and its `earlier` Turns since. Memory lines are
 * compared by their text; removals only in the Profile, since the Log's and Notes' snapshots also
 * lose lines to their ranking and their age.
 */
export function memoryChangeNotes(
  botId: string,
  built: string | null,
  earlier: readonly FeatureEarlierTurn[],
  current: string,
): string[] {
  if (built === null) return [];
  const seen = memoryLinesOf(built);
  for (const { notes, calls } of earlier) {
    applyNotes(seen, notes);
    applyOwnCalls(botId, seen, calls);
  }
  const notes: string[] = [];
  const now = memoryLinesOf(current);
  for (const tier of tiers) {
    const before = new Set(seen[tier]);
    const after = new Set(now[tier]);
    for (const line of after) {
      if (!before.has(line)) notes.push(`Memory added (${tierLabel[tier]}): ${line}`);
    }
    if (tier !== "profile") continue;
    for (const line of before) {
      if (!after.has(line)) notes.push(`Memory removed (${tierLabel[tier]}): ${line}`);
    }
  }
  return notes;
}
