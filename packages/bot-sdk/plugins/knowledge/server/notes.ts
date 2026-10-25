import type { ModelMessage } from "@tanstack/ai";

import type { FeaturePromptTurn } from "../../../core/server/feature";
import { runToolName } from "../../bot/server/context";
import { knowledgeDirectory, readableCopyPath } from "../shared/folder";
import { byCodeUnit, isMoreKnowledge, knowledgeBlockLimit, promptSafePath } from "./prompt";
import { resolvePath } from "../../bot/server/conversation";

/*
 * The Knowledge Change notes (slide 31, ADR 0022 amended, ADR 0025): what the Bot has seen of the
 * Knowledge paths is the section its Prompt start holds, plus the notes it was told since and the
 * files it saved itself. What changed since is told once, in short lines.
 */

/**
 * The Knowledge paths a Knowledge block lists. A capped block lists only the first paths:
 * `listedUpTo` is then the last one it lists, and the Bot was told of none after it.
 */
type Seen = { paths: Set<string>; listedUpTo: string | undefined };

/** A Knowledge block's paths. */
function seenIn(block: string): Seen {
  const paths = new Set<string>();
  let capped = false;
  for (const line of block.split("\n")) {
    if (isMoreKnowledge(line)) capped = true;
    if (line.startsWith("- ")) paths.add(line.slice(2));
  }
  return { paths, listedUpTo: capped ? [...paths].at(-1) : undefined };
}

/** The path inside the Knowledge folder that `path` is, resolved as the write tool resolves it. */
function knowledgeTarget(botId: string, path: string): string | undefined {
  const resolved = resolvePath(botId, path);
  return resolved.startsWith(`${knowledgeDirectory}/`)
    ? resolved.slice(knowledgeDirectory.length + 1)
    : undefined;
}

/** Whether a tool message's content is an error result. */
function resultFailed(content: ModelMessage["content"]): boolean {
  if (typeof content !== "string") return false;
  try {
    const result: unknown = JSON.parse(content);
    return typeof result === "object" && result !== null && "error" in result;
  } catch {
    return false;
  }
}

/** Applies the lines of an earlier Turn's Change notes to `seen`: the Bot was told them. */
function applyNotes(seen: Seen, notes: readonly string[]) {
  for (const note of notes) {
    const knowledge = /^Knowledge (added|removed): (.*)$/.exec(note);
    if (knowledge && knowledge[1] === "added") seen.paths.add(knowledge[2]!);
    if (knowledge && knowledge[1] === "removed") seen.paths.delete(knowledge[2]!);
  }
}

/**
 * Applies the Bot's own `write` and `edit` calls to Knowledge in an earlier Turn's `transcript` to
 * `seen`: it knows what it saved, so it gets no note for it. A shell command doesn't count.
 */
function applyOwnCalls(botId: string, seen: Seen, transcript: readonly ModelMessage[]) {
  // A call that came back with an error changed nothing.
  const failed = new Set(
    transcript.flatMap((entry) =>
      entry.role === "tool" && entry.toolCallId && resultFailed(entry.content)
        ? [entry.toolCallId]
        : [],
    ),
  );
  for (const call of transcript.flatMap((entry) => entry.toolCalls ?? [])) {
    if (failed.has(call.id)) continue;
    let args: { path?: unknown };
    let toolName = call.function.name;
    try {
      args = JSON.parse(call.function.arguments) as { path?: unknown };
      // A call through `run_tool` is the named tool's call.
      if (toolName === runToolName) {
        const wrapped = args as { name?: unknown; args?: unknown };
        if (typeof wrapped.name !== "string" || typeof wrapped.args !== "object" || !wrapped.args)
          continue;
        toolName = wrapped.name;
        args = wrapped.args as { path?: unknown };
      }
    } catch {
      continue;
    }
    if (toolName !== "write" && toolName !== "edit") continue;
    const saved = typeof args.path === "string" ? knowledgeTarget(botId, args.path) : undefined;
    // A path the Knowledge block never lists is never noted either.
    if (saved !== undefined && promptSafePath(saved)) seen.paths.add(saved);
  }
}

/**
 * The Change notes for the readable paths `now`, against the Knowledge `built` into the Bot's
 * Prompt start and what its Turns since (`earlier`) told it or did themselves. None before the
 * Bot has a Knowledge section. A file that was converted since is still there: its readable copy,
 * noted as added, stands for it. A content edit needs no note: the Bot reads the file fresh.
 */
export function knowledgeNotes(
  botId: string,
  built: string | null,
  earlier: FeaturePromptTurn["earlier"],
  now: readonly string[],
): string[] {
  if (built === null) return [];
  const seen = seenIn(built);
  for (const turn of earlier) {
    applyNotes(seen, turn.notes);
    applyOwnCalls(botId, seen, turn.transcript);
  }
  const { paths, listedUpTo } = seen;
  const current = new Set(now);
  // A path past a capped block's last line was never listed, so it is no news.
  const notes = [
    ...now
      .filter((path) => !paths.has(path))
      .filter((path) => listedUpTo === undefined || byCodeUnit(path, listedUpTo) < 0)
      .map((path) => `Knowledge added: ${path}`),
    ...[...paths]
      .filter((path) => {
        const copy = readableCopyPath(path);
        return !current.has(path) && (copy === undefined || !current.has(copy));
      })
      .map((path) => `Knowledge removed: ${path}`),
  ];
  // Capped like the block: the notes left out are told again next Turn, until a Summary.
  const told: string[] = [];
  let length = 0;
  for (const [index, note] of notes.entries()) {
    length += note.length + 1;
    if (length > knowledgeBlockLimit) {
      told.push(`Knowledge changes: ${notes.length - index} more; use \`list\` to see them`);
      break;
    }
    told.push(note);
  }
  return told;
}
