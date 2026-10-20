import type { ModelMessage } from "@tanstack/ai";
import { and, asc, eq, lt } from "drizzle-orm";

import { botPromptStart, botTurn } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { Transaction } from "../../../core/server/plugin";
import type { PromptStartTool } from "./db/bot-prompt-start";
import { createRoutineToolName, deleteRoutineToolName, updateRoutineToolName } from "./turn";
import { canonicalJson, sha256 } from "./prompt-start";

/*
 * Change notes (slide 31, ADR 0022 amended): the Prompt start freezes the memory snapshot, the
 * Routines and the tool definitions, so a Turn tells the Bot what changed since in short lines
 * after the time in its newest message. What the Bot has already seen is the Prompt start plus
 * the notes already in the stored inputs of the Turns since, so nothing is stored for it.
 */

/** The line that opens a newest message's Change notes. */
export const changeNotesHeader = "[What changed since your prompt was built]";

/** What a Turn reads now, as recorded activities: the memory block, the Routines and the tools. */
export type CurrentState = {
  /** The memory block, or null with Memory off or unreadable. */
  memory: string | null;
  /** The Routines block, or null when the Bot has none. */
  routines: string | null;
  /** The live tools' definitions. */
  tools: PromptStartTool[];
};

type Tier = "profile" | "log" | "notes";
const tiers: Tier[] = ["profile", "log", "notes"];
const tierHeading: Record<string, Tier> = { Profile: "profile", Log: "log", Notes: "notes" };
const tierLabel: Record<Tier, string> = { profile: "Profile", log: "Log", notes: "Notes" };

type MemoryLines = Record<Tier, string[]>;

/** What the Bot has seen: the memory lines (null without a memory block), Routines and tools. */
type Seen = {
  memory: MemoryLines | null;
  routines: Map<string, string>;
  /** Each tool's definition hash. */
  tools: Map<string, string>;
};

const waiting = "(waiting for OK)";

/** The first eight hex digits of a tool definition's sha256: enough to tell one deploy from another. */
export const toolHash = (tool: PromptStartTool) => sha256(canonicalJson(tool)).slice(0, 8);

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

/** A Routines block's lines by Routine name. */
function routinesOf(block: string | null | undefined): Map<string, string> {
  const routines = new Map<string, string>();
  for (const line of block?.split("\n").slice(1) ?? []) {
    routines.set(line.split("  ")[0]!, line);
  }
  return routines;
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

/** The lines of the Change notes in a stored message, none when it has no notes. */
function notesIn(message: ModelMessage): string[] {
  if (typeof message.content !== "string") return [];
  const block = message.content.split("\n\n")[1];
  return block?.startsWith(`${changeNotesHeader}\n`) ? block.split("\n").slice(1) : [];
}

const removeOne = (lines: string[], text: string) => {
  const at = lines.indexOf(text);
  if (at >= 0) lines.splice(at, 1);
};

/** Applies the lines of an earlier Turn's Change notes to `seen`: the Bot was told them. */
function applyNotes(seen: Seen, notes: string[]) {
  for (const note of notes) {
    const memory = /^Memory (added|removed) \((Profile|Log|Notes)\): (.*)$/.exec(note);
    if (memory) {
      const lines = seen.memory?.[tierHeading[memory[2]!]!];
      if (!lines) continue;
      if (memory[1] === "added") lines.push(memory[3]!);
      else removeOne(lines, memory[3]!);
      continue;
    }
    const routine = /^Routine (?:created|approved|changed): (.*)$/.exec(note);
    if (routine) seen.routines.set(routine[1]!.split("  ")[0]!, routine[1]!);
    const deleted = /^Routine deleted: (.*)$/.exec(note);
    if (deleted) seen.routines.delete(deleted[1]!);
    const tool = /^\[Tool changed: (.+?)\. .*\(definition ([0-9a-f]{8})\)\]$/.exec(note);
    if (tool) seen.tools.set(tool[1]!, tool[2]!);
  }
}

type CallArguments = {
  path?: unknown;
  content?: unknown;
  oldText?: unknown;
  newText?: unknown;
  name?: unknown;
};

/** What `seen` holds for a Routine the Bot created or changed itself: known, with no line yet. */
const ownRoutine = "";

/**
 * Applies the Bot's own memory writes and Routine tool calls in an earlier Turn's `transcript` to
 * `seen`: it knows what it did, so it gets no note for it. Only its `write` and `edit` calls count
 * for memory, not a shell command.
 */
function applyOwnCalls(botId: string, seen: Seen, transcript: ModelMessage[]) {
  const { memory } = seen;
  for (const call of transcript.flatMap((entry) => entry.toolCalls ?? [])) {
    let args: CallArguments;
    try {
      args = JSON.parse(call.function.arguments) as CallArguments;
    } catch {
      continue;
    }
    if (typeof args.name === "string") {
      if (
        call.function.name === createRoutineToolName ||
        call.function.name === updateRoutineToolName
      ) {
        seen.routines.set(args.name, ownRoutine);
      } else if (call.function.name === deleteRoutineToolName) {
        seen.routines.delete(args.name);
      }
    }
    if (!memory || (call.function.name !== "write" && call.function.name !== "edit")) continue;
    const target = typeof args.path === "string" ? memoryTarget(botId, args.path) : undefined;
    if (!target) continue;
    const lines = memory[target.tier];
    if (call.function.name === "write" && typeof args.content === "string") {
      // The file is replaced whole: its own lines in `seen` go, and what it holds now is seen.
      const own = (line: string) =>
        target.tier === "profile"
          ? !line.startsWith("[")
          : target.tier === "log"
            ? line.startsWith(`${target.month}-`)
            : true;
      memory[target.tier] = [...lines.filter((line) => !own(line)), ...fileLines(args.content)];
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
 * The Change notes block for the newest message of a Turn that started at `turn.startedAt`, or
 * `undefined` when nothing changed since the Bot's Prompt start `startId` and the notes of its
 * earlier Turns. Memory lines are compared by their text; removals only in the Profile, since the
 * Log's and Notes' snapshots also lose lines to their ranking and their age. A tool is noted when
 * its live definition differs from the one the Bot last saw.
 */
export async function changeNotesFor(
  db: Database | Transaction,
  turn: { botId: string; startedAt: Date },
  startId: string,
  current: CurrentState,
): Promise<string | undefined> {
  const [start] = await db.select().from(botPromptStart).where(eq(botPromptStart.id, startId));
  if (!start) return undefined;
  const block = (name: string) => start.sections.find((section) => section.name === name)?.text;
  const memoryBlock = block("memory");
  const seen: Seen = {
    memory: memoryBlock === undefined ? null : memoryLinesOf(memoryBlock),
    routines: routinesOf(block("routines")),
    tools: new Map(start.tools.map((tool) => [tool.name, toolHash(tool)])),
  };
  const earlier = await db
    .select({ input: botTurn.input, transcript: botTurn.transcript })
    .from(botTurn)
    .where(
      and(
        eq(botTurn.botId, turn.botId),
        eq(botTurn.promptStartId, startId),
        lt(botTurn.startedAt, turn.startedAt),
      ),
    )
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));
  for (const row of earlier) {
    for (const message of row.input ?? []) applyNotes(seen, notesIn(message));
    applyOwnCalls(turn.botId, seen, row.transcript ?? []);
  }

  const notes: string[] = [];
  if (seen.memory && current.memory !== null) {
    const now = memoryLinesOf(current.memory);
    for (const tier of tiers) {
      const before = new Set(seen.memory[tier]);
      const after = new Set(now[tier]);
      for (const line of after) {
        if (!before.has(line)) notes.push(`Memory added (${tierLabel[tier]}): ${line}`);
      }
      if (tier !== "profile") continue;
      for (const line of before) {
        if (!after.has(line)) notes.push(`Memory removed (${tierLabel[tier]}): ${line}`);
      }
    }
  }
  const routines = routinesOf(current.routines);
  for (const [name, line] of routines) {
    const before = seen.routines.get(name);
    if (before === undefined) notes.push(`Routine created: ${line}`);
    // One the Bot made itself, still waiting for the user, has nothing new to tell.
    else if (before === ownRoutine && line.endsWith(waiting)) continue;
    else if (before !== line) {
      const approved =
        (before === ownRoutine || before.endsWith(waiting)) && !line.endsWith(waiting);
      notes.push(`Routine ${approved ? "approved" : "changed"}: ${line}`);
    }
  }
  for (const name of seen.routines.keys()) {
    if (!routines.has(name)) notes.push(`Routine deleted: ${name}`);
  }
  for (const tool of current.tools) {
    const before = seen.tools.get(tool.name);
    const hash = toolHash(tool);
    if (before !== undefined && before !== hash) {
      notes.push(
        `[Tool changed: ${tool.name}. Its description or arguments changed in a deploy; call it ` +
          `the way it is described now. (definition ${hash})]`,
      );
    }
  }
  return notes.length > 0 ? [changeNotesHeader, ...notes].join("\n") : undefined;
}
