import type { BotKnowledgeChange } from "@botsdk/client/knowledge/changes";
import type { ModelMessage } from "@tanstack/ai";

/** A user's Knowledge folder on their Computer, shared by all of their Bots (ADR 0025). */
export const knowledgeDirectory = "/home/user/shared/knowledge";

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

/** The most listing bytes a walk reads; the entries past it are left out. */
export const walkListingBytes = 1024 * 1024;

/**
 * Lists the tree under `$d` in one pass of `find`, without following symlinks. It prints base64 of
 * one NUL-ended entry per folder (`d 0 0 <relative path>`) and file (`f <size> <mtime> <relative
 * path>`), cut at `walkListingBytes` (NUL-ended, so a name with a line break stays one entry),
 * then a line with the bytes all files hold, then one with the whole listing's length. Prints
 * nothing when there is no folder yet.
 */
export const walkScript = [
  `[ -d "$d" ] || exit 0`,
  `l=$(mktemp) && t=$(mktemp) || exit 1`,
  String.raw`find "$d" -mindepth 1 \( -type d -printf 'd 0 0 %P\0' -o -type f -printf 'f %s %T@ %P\0' -fprintf "$t" '%s\n' \) > "$l" 2>/dev/null`,
  `head -c ${walkListingBytes} "$l" | base64 -w0`,
  String.raw`printf '\n'`,
  `awk '{ s += $1 } END { print s + 0 }' "$t"`,
  `wc -c < "$l"`,
  `rm -f "$l" "$t"`,
].join("\n");

/** Prints the mtime and size of the file `$p`, as a walk's stamp; nothing when there is none. */
export const stampScript = String.raw`find "$p" -maxdepth 0 -type f -printf '%T@ %s' 2>/dev/null; true`;
