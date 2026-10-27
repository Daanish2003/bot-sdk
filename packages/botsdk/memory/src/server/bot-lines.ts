import type { FeatureContext } from "@botsdk/bot/feature";

import { rpcError } from "@botsdk/bot/rpc-error";
import { ComputerUnavailableError, type ComputerHandle } from "@botsdk/bot/computer/internal";
import {
  botsOf,
  dayOf,
  defaultImportance,
  logPath,
  logMonthsOf,
  memoryLines,
  notesPath,
  parseLog,
  parseNotes,
  parseProfile,
  profilePath,
  readBotMemory,
  readText,
} from "./bot-memory";
import { memoryEnabledFor } from "./manage";

/*
 * The user's view of Bot memory (ADR 0022): list the lines of the files with whether the Turn's
 * snapshot holds them, edit, delete and add a line, and read or save a file whole. It works on the
 * same plain files the Bots write, through the user's Computer.
 */

import type {
  BotMemoryList,
  ListedLogLine,
  ListedNoteLine,
  ListedProfileLine,
  MemoryFileRef,
  MemoryTier,
} from "../shared/contract";

export type {
  BotMemoryList,
  ListedLogLine,
  ListedNoteLine,
  ListedProfileLine,
  MemoryFileRef,
  MemoryTier,
};

/** The path of a memory file; a Log file needs its month. */
export function memoryFilePath({ botId, tier, month }: MemoryFileRef): string {
  if (tier === "profile") return profilePath(botId);
  if (tier === "notes") return notesPath(botId);
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw rpcError("BAD_REQUEST", "error.memoryLogMonth", "A Log file needs a month, YYYY-MM");
  }
  return logPath(botId, month);
}

/** The user's Computer, or the error the popover shows when there is none to read. */
function computerOf(deps: FeatureContext<"computer">, userId: string): ComputerHandle {
  if (!deps.computer) {
    throw rpcError("BAD_REQUEST", "error.memoryNeedsComputer", "Bot memory needs a Computer");
  }
  return deps.computer.forUser(userId);
}

/** Runs a Computer operation; a Computer that can't be woken is a refusal, not a crash. */
async function onComputer<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (caught) {
    if (caught instanceof ComputerUnavailableError) {
      throw rpcError(
        "BAD_REQUEST",
        "error.memoryComputerUnavailable",
        "Your Computer can't be reached right now",
      );
    }
    throw caught;
  }
}

/** Refuses a Bot that isn't one of the user's Bots. */
async function requireOwnBot(deps: FeatureContext<"computer">, userId: string, botId: string) {
  const bots = await botsOf(deps, userId);
  if (!bots.some((other) => other.id === botId)) {
    throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  }
  return bots;
}

/**
 * Bot `botId`'s memory for the popover as of `now`: its own and the other Bots' Profile lines, its
 * Log lines of every month and its Notes, each with whether the Turn's snapshot holds it
 * (the snapshot's own selection, read the same way).
 */
export async function listBotMemory(
  deps: FeatureContext<"computer">,
  { userId, botId, now }: { userId: string; botId: string; now: Date },
): Promise<BotMemoryList> {
  const bots = await requireOwnBot(deps, userId, botId);
  const available = Boolean(deps.computer);
  const enabled = await memoryEnabledFor(deps, userId);
  if (!available || !enabled) return { available, enabled, profile: [], log: [], notes: [] };
  return onComputer(async () => {
    const computer = computerOf(deps, userId);
    const snapshot = await readBotMemory(computer, { botId, bots, now });
    const profileIn = new Set(snapshot.profile.map((entry) => `${entry.botId}:${entry.line}`));
    const logIn = new Set(snapshot.log.map((entry) => `${entry.month}:${entry.line}`));
    const notesIn = new Set(snapshot.notes.map((entry) => entry.line));

    const owners = [
      { id: botId, name: null as string | null },
      ...bots.filter((other) => other.id !== botId),
    ];
    const profiles = await Promise.all(
      owners.map(async (owner) => ({
        owner,
        lines: parseProfile(await readText(computer, profilePath(owner.id))),
      })),
    );
    const months = await logMonthsOf(computer, botId);
    const logs = await Promise.all(
      months.map(async (month) => parseLog(await readText(computer, logPath(botId, month)), month)),
    );
    const notes = parseNotes(await readText(computer, notesPath(botId)), dayOf(now));

    return {
      available,
      enabled,
      profile: profiles.flatMap(({ owner, lines }) =>
        lines.map((entry) => ({
          botId: owner.id,
          botName: owner.name,
          line: entry.line,
          text: entry.text,
          inPrompt: profileIn.has(`${owner.id}:${entry.line}`),
        })),
      ),
      log: logs
        .flat()
        .map((entry) => ({
          month: entry.month,
          line: entry.line,
          text: entry.text,
          body: entry.event,
          date: entry.date,
          importance: entry.importance,
          inPrompt: logIn.has(`${entry.month}:${entry.line}`),
        }))
        .sort((a, b) => b.date.localeCompare(a.date) || a.line - b.line),
      notes: notes.map((entry) => ({
        line: entry.line,
        text: entry.text,
        body: entry.detail,
        date: entry.date,
        inPrompt: notesIn.has(entry.line),
      })),
    };
  });
}

/** A line's text as one line: whitespace around newlines collapses, and blank is refused. */
function lineText(text: string): string {
  const one = text.replace(/\s*\r?\n\s*/g, " ").trim();
  if (one === "") throw rpcError("BAD_REQUEST", "error.memoryTextBlank", "Text can't be blank");
  return one;
}

const changedUnderneath = () =>
  rpcError(
    "CONFLICT",
    "error.memoryLineChanged",
    "That line changed since you opened it. Reload and try again.",
  );

/**
 * `content` with line `line` (1-based) set to `text`, keeping its `- ` marker, or removed when
 * `text` is null. Throws a refusal unless that line's text is still `current`.
 */
export function changeLine(
  content: string,
  line: number,
  current: string,
  text: string | null,
): string {
  const rows = content.split("\n");
  const raw = rows[line - 1];
  if (raw === undefined || memoryLines(raw)[0]?.text !== current) throw changedUnderneath();
  if (text === null) {
    rows.splice(line - 1, 1);
  } else {
    const marker = /^\s*[-*]\s+/.exec(raw)?.[0] ?? "";
    rows[line - 1] = `${marker}${text}${raw.endsWith("\r") ? "\r" : ""}`;
  }
  return rows.join("\n");
}

/** `content` with `- text` added as its last line. */
export function appendLine(content: string, text: string): string {
  const head = content === "" || content.endsWith("\n") ? content : `${content}\n`;
  return `${head}- ${text}\n`;
}

/** Changes line `line` of a file of one of the user's Bots to `text`; refused if it changed. */
export async function editBotLine(
  deps: FeatureContext<"computer">,
  {
    userId,
    file,
    line,
    current,
    text,
  }: { userId: string; file: MemoryFileRef; line: number; current: string; text: string },
) {
  const next = lineText(text);
  await requireOwnBot(deps, userId, file.botId);
  const path = memoryFilePath(file);
  const computer = computerOf(deps, userId);
  await onComputer(async () => {
    const content = await readText(computer, path);
    await computer.writeFile(path, changeLine(content, line, current, next));
  });
}

/** Deletes line `line` of a file of one of the user's Bots; refused if it changed. */
export async function deleteBotLine(
  deps: FeatureContext<"computer">,
  {
    userId,
    file,
    line,
    current,
  }: { userId: string; file: MemoryFileRef; line: number; current: string },
) {
  await requireOwnBot(deps, userId, file.botId);
  const path = memoryFilePath(file);
  const computer = computerOf(deps, userId);
  await onComputer(async () => {
    const content = await readText(computer, path);
    await computer.writeFile(path, changeLine(content, line, current, null));
  });
}

/**
 * Adds a line to the Bot's Profile, to this month's Log (dated today, importance 5) or to its
 * Notes (dated today).
 */
export async function addBotLine(
  deps: FeatureContext<"computer">,
  { userId, botId, tier, text }: { userId: string; botId: string; tier: MemoryTier; text: string },
) {
  const body = lineText(text);
  await requireOwnBot(deps, userId, botId);
  const now = deps.clock();
  const today = dayOf(now);
  const file: MemoryFileRef =
    tier === "log" ? { botId, tier, month: today.slice(0, 7) } : { botId, tier };
  const line =
    tier === "profile"
      ? body
      : tier === "log"
        ? `${today} (importance ${defaultImportance}) ${body}`
        : `${today} ${body}`;
  const path = memoryFilePath(file);
  const computer = computerOf(deps, userId);
  await onComputer(async () => {
    await computer.writeFile(path, appendLine(await readText(computer, path), line));
  });
}

/** A file's raw text, "" when there is none. */
export async function readBotFile(
  deps: FeatureContext<"computer">,
  { userId, file }: { userId: string; file: MemoryFileRef },
): Promise<string> {
  await requireOwnBot(deps, userId, file.botId);
  const path = memoryFilePath(file);
  const computer = computerOf(deps, userId);
  return onComputer(() => readText(computer, path));
}

/**
 * Saves a file's whole text, replacing what is there; refused when the file no longer reads
 * `expected`, the text the user started from.
 */
export async function saveBotFile(
  deps: FeatureContext<"computer">,
  {
    userId,
    file,
    expected,
    content,
  }: { userId: string; file: MemoryFileRef; expected: string; content: string },
) {
  await requireOwnBot(deps, userId, file.botId);
  const path = memoryFilePath(file);
  const computer = computerOf(deps, userId);
  await onComputer(async () => {
    if ((await readText(computer, path)) !== expected) throw changedUnderneath();
    await computer.writeFile(path, content);
  });
}
