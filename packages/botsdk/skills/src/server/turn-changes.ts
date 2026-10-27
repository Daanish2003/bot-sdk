import type { BotSkillChange } from "@botsdk/client/skills/changes";
import type { ModelMessage } from "@tanstack/ai";

import { skillsDirectory } from "@botsdk/bot/bot/skill-files";
import { writtenFiles } from "@botsdk/bot/feature";

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
  const changes = new Map<string, BotSkillChange>();
  for (const { path, created } of writtenFiles(transcript)) {
    const name = path.startsWith(prefix)
      ? /^([^/]+)\/SKILL\.md$/.exec(path.slice(prefix.length))?.[1]
      : undefined;
    if (!name) continue;
    if (changes.get(name)?.kind === "saved") continue;
    changes.set(name, { kind: created ? "saved" : "updated", name });
  }
  return changes.size > 0 ? [...changes.values()] : null;
}
