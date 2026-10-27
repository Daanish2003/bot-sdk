import type { BotSkillChange } from "@botsdk/client/skills/changes";
import type { ModelMessage } from "@tanstack/ai";

/*
 * A Bot's Skills on the Computer (spec #713): each a plain `SKILL.md` in its own folder in the
 * Bot's directory. The Skills feature reads and manages them; the core knows their place and
 * format too, because Demonstrations draft Skills and a Turn's Skill chip lists the ones it wrote.
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

/**
 * The Skills a Turn's `transcript` wrote, for its Skill chip: its successful `write` and `edit`
 * calls of Bot `botId`'s own `skills/<name>/SKILL.md`, in the order each Skill was first written.
 * A `write` that created the file (the result says `created`) makes the Skill `saved`, and
 * anything else `updated`; a Skill saved earlier in the Turn stays `saved`. Null for none. Other
 * Bots' folders and other files are ignored.
 */
export function skillChangesOf(
  botId: string,
  transcript: readonly ModelMessage[],
): BotSkillChange[] | null {
  const prefix = `${skillsDirectory(botId)}/`;
  const names = new Map<string, string>();
  for (const entry of transcript) {
    for (const call of entry.toolCalls ?? []) names.set(call.id, call.function.name);
  }
  const changes = new Map<string, BotSkillChange>();
  for (const entry of transcript) {
    if (entry.role !== "tool" || !entry.toolCallId || typeof entry.content !== "string") continue;
    let result: { path?: unknown; error?: unknown; created?: unknown };
    try {
      result = JSON.parse(entry.content);
    } catch {
      continue;
    }
    if (typeof result !== "object" || result === null || "error" in result) continue;
    const called = names.get(entry.toolCallId);
    if (called !== "write" && called !== "edit" && called !== "run_tool") continue;
    const path = typeof result.path === "string" ? result.path : "";
    const name = path.startsWith(prefix)
      ? /^([^/]+)\/SKILL\.md$/.exec(path.slice(prefix.length))?.[1]
      : undefined;
    if (!name) continue;
    if (changes.get(name)?.kind === "saved") continue;
    changes.set(name, { kind: result.created === true ? "saved" : "updated", name });
  }
  return changes.size > 0 ? [...changes.values()] : null;
}

/** Whether `path` (absolute) is the SKILL.md of a Skill in Bot `botId`'s own Skills folder. */
export function isSkillFile(botId: string, path: string): boolean {
  const prefix = `${skillsDirectory(botId)}/`;
  return path.startsWith(prefix) && /^[^/]+\/SKILL\.md$/.test(path.slice(prefix.length));
}
