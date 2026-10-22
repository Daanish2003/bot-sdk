import type { ModelMessage } from "@tanstack/ai";

import { knowledgeDirectory } from "../shared/folder";
import type { BotKnowledgeChange } from "../shared/changes";

/**
 * The files a Turn's `transcript` saved to Knowledge, for its chip: the paths of its successful
 * `write`, `edit` and `run_tool` calls under the Knowledge folder, relative to it, once each, in the order they
 * were first written. Writes elsewhere (the Bot's own folder, memory, Skills) are ignored. Null for
 * none.
 */
export function knowledgeChangesOf(
  botId: string,
  transcript: readonly ModelMessage[],
): BotKnowledgeChange[] | null {
  const prefix = `${knowledgeDirectory}/`;
  const names = new Map<string, string>();
  for (const entry of transcript) {
    for (const call of entry.toolCalls ?? []) names.set(call.id, call.function.name);
  }
  const paths = new Set<string>();
  for (const entry of transcript) {
    if (entry.role !== "tool" || !entry.toolCallId || typeof entry.content !== "string") continue;
    const called = names.get(entry.toolCallId);
    if (called !== "write" && called !== "edit" && called !== "run_tool") continue;
    let result: { path?: unknown; error?: unknown };
    try {
      result = JSON.parse(entry.content);
    } catch {
      continue;
    }
    if (typeof result !== "object" || result === null || "error" in result) continue;
    if (typeof result.path === "string" && result.path.startsWith(prefix)) {
      paths.add(result.path.slice(prefix.length));
    }
  }
  return paths.size > 0 ? [...paths].map((path) => ({ botId, path })) : null;
}
