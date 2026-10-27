import type { BotKnowledgeChange } from "@botsdk/client/knowledge/changes";
import type { ModelMessage } from "@tanstack/ai";

import { knowledgeDirectory } from "@botsdk/bot/bot/knowledge-files";
import { writtenFiles } from "@botsdk/bot/feature";

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
  const paths = new Set<string>();
  for (const { path } of writtenFiles(transcript)) {
    if (path.startsWith(prefix)) paths.add(path.slice(prefix.length));
  }
  return paths.size > 0 ? [...paths].map((path) => ({ botId, path })) : null;
}
