/*
 * A Bot's Skills on the Computer (spec #713): each a plain `SKILL.md` in its own folder in the
 * Bot's directory. The Skills feature reads and manages them; the core knows their place and
 * format too, because Demonstrations draft Skills.
 */

/** A Bot's Skills folder on its user's Computer. */
export function skillsDirectory(botId: string): string {
  return `/home/user/bots/${botId}/skills`;
}

/** The longest a Skill's `name` may be. */
export const nameLimit = 64;
/** The longest a Skill's `description` may be. */
const descriptionLimit = 200;
export const namePattern = /^[a-z0-9-]+$/;
const descriptionStart = "Use this when";

/** The `key: value` lines of a `SKILL.md`'s frontmatter, or null when it has none. */
export function frontmatterOf(content: string): Map<string, string> | null {
  const lines = content.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    const value = field[2]!.trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    fields.set(field[1]!, quoted ? quoted[2]! : value);
  }
  return fields;
}

/** Why Skill folder `folder`'s `SKILL.md` (`content`, null when missing) is not usable, or null. */
export function problemOf(folder: string, content: string | null): string | null {
  if (content === null) return "no SKILL.md";
  const fields = frontmatterOf(content);
  if (!fields) return "no frontmatter";
  const name = fields.get("name");
  if (!name) return "name is missing";
  if (!namePattern.test(name) || name.length > nameLimit) {
    return `name must be lowercase a-z, 0-9 and -, at most ${nameLimit} characters`;
  }
  if (name !== folder) return `name "${name}" must equal the folder name`;
  const description = fields.get("description");
  if (!description) return "description is missing";
  if (!description.startsWith(descriptionStart)) {
    return `description must start with "${descriptionStart}"`;
  }
  if (description.length > descriptionLimit) {
    return `description is over ${descriptionLimit} characters`;
  }
  return null;
}

/** Whether `path` (absolute) is the SKILL.md of a Skill in Bot `botId`'s own Skills folder. */
export function isSkillFile(botId: string, path: string): boolean {
  const prefix = `${skillsDirectory(botId)}/`;
  return path.startsWith(prefix) && /^[^/]+\/SKILL\.md$/.test(path.slice(prefix.length));
}

/** How much of each SKILL.md `readBotSkills` looks through for its frontmatter. */
export const skillHeadBytes = 65_536;

/**
 * `readBotSkills`' one command, after `d=<Skills folder>`: a line per folder in it, its name in
 * base64, then `none` (no SKILL.md), `unreadable` (not a file, or denied), or `file` and, in
 * base64, the SKILL.md's lines up to the second `---` line (the frontmatter's end), from its first
 * `skillHeadBytes` bytes, each line ending in a newline. Prints nothing when there is no Skills
 * folder. awk reads all it is given, so head never meets a closed pipe.
 */
export const readSkillsScript = [
  "set -o pipefail",
  "shopt -s nullglob dotglob",
  `[ -d "$d" ] || exit 0`,
  `for f in "$d"/*/; do`,
  `  n=\${f%/}; n=\${n##*/}; s="\${f}SKILL.md"`,
  `  if [ ! -e "$s" ]; then r=none`,
  `  elif [ -f "$s" ] && c=$(head -c ${skillHeadBytes} -- "$s" | awk '!done { print } /^[[:space:]]*---[[:space:]]*$/ && ++n == 2 { done = 1 }' | base64 -w0); then r="file $c"`,
  `  else r=unreadable; fi`,
  `  printf '%s %s\\n' "$(printf %s "$n" | base64 -w0)" "$r"`,
  "done",
].join("\n");
