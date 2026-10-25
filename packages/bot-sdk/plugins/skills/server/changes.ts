import type { FeatureEarlierTurn } from "../../../core/server/feature";
import { resolvePath } from "../../bot/server/computer-tools";
import { isSkillFile, type SkillLine, skillLineOf, skillsDirectory } from "./skills";

/*
 * The Skills feature's Change notes (slide 31): what the Bot has been told of its Skills since its
 * Prompt start, and what it did to them itself, against the Skills now.
 */

/**
 * The Skills a Skills block lists, each Skill's text by name. A capped block lists only the first
 * Skills by name: `listedUpTo` is then the last one it lists, and the Bot was told of none after it.
 */
type SeenSkills = { lines: Map<string, string>; listedUpTo: string | undefined };

/**
 * A Skill's `<name>: <text>`, split. A usable Skill's name has no ": ", but a broken one's is any
 * folder name, so its text is found by its `(not usable: …)` end instead.
 */
function skillParts(entry: string): [name: string, text: string] | undefined {
  const broken = /^(.+): (\(not usable: .*\))$/.exec(entry);
  if (broken) return [broken[1]!, broken[2]!];
  const at = entry.indexOf(": ");
  return at > 0 ? [entry.slice(0, at), entry.slice(at + 2)] : undefined;
}

/** A Skills block's Skills. */
function skillsOf(block: string): SeenSkills {
  const lines = new Map<string, string>();
  let capped = false;
  for (const line of block.split("\n")) {
    if (/^\d+ more Skills: /.test(line)) capped = true;
    const parts = line.startsWith("- ") ? skillParts(line.slice(2)) : undefined;
    if (parts) lines.set(...parts);
  }
  return { lines, listedUpTo: capped ? [...lines.keys()].at(-1) : undefined };
}

/** How long the Skills lines of one Turn's Change notes may be, as the Skills block. */
const skillNotesLimit = 8_000;

/**
 * The folder of the Skill in the Bot's own folder that `path` is the SKILL.md of, if any, with
 * `path` resolved as the write and edit tools resolve it.
 */
function skillTarget(botId: string, path: string): string | undefined {
  const resolved = resolvePath(botId, path);
  return isSkillFile(botId, resolved)
    ? resolved.slice(skillsDirectory(botId).length + 1).split("/")[0]
    : undefined;
}

/** The description an `edit`'s new text sets, quotes removed. */
function descriptionIn(text: string): string | undefined {
  const value = /^description:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1];
  return value === undefined ? undefined : (/^(["'])(.*)\1$/.exec(value)?.[2] ?? value);
}

/**
 * The Change notes for Bot `botId`'s Skills `now`, given the Skills block its Prompt start holds
 * (`built`) and the `earlier` Turns since: nothing without that block. The Bot was told the notes
 * of those Turns, and it knows the Skills it wrote itself, so neither is told again. Capped like the
 * block: the notes left out are told again next Turn, until a Summary.
 */
export function skillChangeNotes(
  botId: string,
  built: string | null,
  earlier: readonly FeatureEarlierTurn[],
  now: SkillLine[],
): string[] {
  if (built === null) return [];
  const { lines, listedUpTo } = skillsOf(built);
  for (const turn of earlier) {
    for (const note of turn.told) {
      const changed = /^Skill (?:added|changed): (.*)$/.exec(note);
      const parts = changed && skillParts(changed[1]!);
      if (parts) lines.set(...parts);
      const removed = /^Skill removed: (.*)$/.exec(note);
      if (removed) lines.delete(removed[1]!);
    }
    for (const { tool, args } of turn.calls) {
      if (tool !== "write" && tool !== "edit") continue;
      const skill = typeof args.path === "string" ? skillTarget(botId, args.path) : undefined;
      if (skill === undefined) continue;
      // The Bot knows its own Skill write. A body edit changes nothing the block lists.
      if (tool === "write" && typeof args.content === "string") {
        lines.set(skill, skillLineOf(skill, args.content).text);
      } else if (typeof args.newText === "string") {
        // Only an edit that replaces the description line itself changes it.
        const description =
          typeof args.oldText === "string" && /^description:/m.test(args.oldText)
            ? descriptionIn(args.newText)
            : undefined;
        if (description !== undefined) lines.set(skill, description);
      }
    }
  }
  const notes: string[] = [];
  for (const { name, text } of now) {
    const before = lines.get(name);
    // A Skill past a capped block's last line was never listed, so it is no news.
    if (before === undefined && listedUpTo !== undefined && name > listedUpTo) continue;
    if (before === undefined) notes.push(`Skill added: ${name}: ${text}`);
    // Only the description is in the block: a body edit needs no note, the Bot reads it fresh.
    else if (before !== text) notes.push(`Skill changed: ${name}: ${text}`);
  }
  const here = new Set(now.map((skill) => skill.name));
  for (const name of lines.keys()) {
    if (!here.has(name)) notes.push(`Skill removed: ${name}`);
  }
  const told: string[] = [];
  let length = 0;
  for (const [index, note] of notes.entries()) {
    length += note.length + 1;
    if (length > skillNotesLimit) {
      told.push(`Skill changes: ${notes.length - index} more; list \`skills/\` to see them`);
      break;
    }
    told.push(note);
  }
  return told;
}
