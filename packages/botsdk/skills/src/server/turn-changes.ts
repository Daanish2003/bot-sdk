import type { BotSkillChange } from "@botsdk/client/skills/changes";
import type { ModelMessage } from "@tanstack/ai";

import { skillsDirectory } from "@botsdk/bot/bot/skill-files";

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
