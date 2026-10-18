import { posix } from "node:path";

import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { BotSdkContext } from "../../../core/server/plugin";
import { type ComputerHandle, defaultCommandTimeoutMs } from "../../computer/server/plugin";
import type { CommandResult, TimedOutCommand } from "../../computer/server/provider";

/** The Computer tool that runs a shell command. */
export const shellToolName = "shell";

/** The `shell` call's start marker, recorded before the command runs live. */
export const shellStartActivity = "shell_start";

/** How long a `shell` command may run when the Bot doesn't say. */
export const defaultShellTimeoutSeconds = defaultCommandTimeoutMs / 1000;

/** What a tool returns when the Computer couldn't wake. */
export const computerUnavailableError =
  "Your computer couldn't start. Try again shortly; if it keeps failing, tell the user their " +
  "computer is unavailable right now.";

/** What a resumed Turn returns for a `shell` call that started but has no result. */
export const interruptedShellError =
  "This command was interrupted by a restart and may have partly run. Check its effects before " +
  "running it again.";

/** What a `shell` call killed at its time limit adds to the output it printed. */
export const timedOutHint =
  "The command was killed at its time limit. Break the work up into shorter commands, or give a " +
  "longer timeoutSeconds if this turn has time left.";

/** The user's Computer. Call it only with `computer` on (`hasPlugin("computer")`). */
export function computerOf(deps: BotSdkContext, userId: string): ComputerHandle {
  return deps.plugin("computer").forUser(userId);
}

/** The directory the user's Bots share on their Computer. */
export const sharedDirectory = "/home/user/shared";

/** A Bot's own directory on its user's Computer, where its relative paths and commands start. */
export function botDirectory(botId: string): string {
  return `/home/user/bots/${botId}`;
}

/** Where a `shell` call runs: `cwd` against the Bot's directory, or that directory itself. */
export function shellCwd(botId: string, cwd: string | undefined): string {
  return posix.resolve(botDirectory(botId), cwd ?? ".");
}

/** What the system prompt says about the Computer, with the Bot's own directory in it. */
export function computerPrompt(botId: string): string {
  return (
    "You have a computer: a Linux machine you share with the user's other Bots. Run commands on " +
    `it with the ${shellToolName} tool. Your own directory is ${botDirectory(botId)}: commands run ` +
    "there unless you give another cwd, so keep your files there. The user's Bots share " +
    `${sharedDirectory}, to hand files to each other. Keep to your own directory and the shared ` +
    "one, and don't change other Bots' files. The user never sees the computer: tell them what " +
    "you did through your messages."
  );
}

export const shellDefinition = toolDefinition({
  name: shellToolName,
  description:
    "Run a shell command on your computer with bash, and get its exit code, stdout and stderr. A " +
    "non-zero exit code is a normal result. It runs in your own directory unless you give a cwd.",
  inputSchema: z.object({
    command: z.string().meta({ description: "The command line, run with bash -l -c." }),
    cwd: z.string().optional().meta({
      description: "Where to run it: absolute, or relative to your own directory.",
    }),
    timeoutSeconds: z
      .number()
      .positive()
      .optional()
      .meta({
        description:
          `How long it may run, in seconds (${defaultShellTimeoutSeconds} by default, and never ` +
          "past this turn's time left). It is killed then, and you get what it printed so far.",
      }),
  }),
});
/** Resolves a tool's path: relative to the Bot's directory, or absolute anywhere. */
export function resolvePath(botId: string, path: string | undefined): string {
  return posix.resolve(botDirectory(botId), path ?? ".");
}

/** A `shell` output longer than this goes to a file. */
export const spillThreshold = 10_000;
/** How much of each end of a spilled output the result keeps. */
const spillKeep = 2_000;

/** What `shell` returns: the command's result, with long outputs cut and the file that holds them. */
export type ShellOutput = (CommandResult | TimedOutCommand) & { outputPath?: string };

/** Where the full output of tool call `toolCallId` goes, in the Bot's directory. */
export function spillPath(botId: string, toolCallId: string): string {
  return posix.join(botDirectory(botId), ".outputs", `${toolCallId}.txt`);
}

const keepEnds = (text: string) =>
  `${text.slice(0, spillKeep)}\n[... ${text.length - 2 * spillKeep} characters left out ...]\n${text.slice(-spillKeep)}`;

/**
 * Caps a command's result. When stdout or stderr is over the threshold, `save` stores the full
 * output (both streams, labelled, when both are long) at `path`, and the result keeps the first
 * and last characters of each long stream plus that path.
 */
export async function capOutput(
  result: CommandResult | TimedOutCommand,
  path: string,
  save: (path: string, content: string) => Promise<void>,
): Promise<ShellOutput> {
  const longOut = result.stdout.length > spillThreshold;
  const longErr = result.stderr.length > spillThreshold;
  if (!longOut && !longErr) return result;
  const content =
    longOut && longErr
      ? `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
      : longOut
        ? result.stdout
        : result.stderr;
  // The command has already run, so a failed save must not fail the call: the result goes without the file.
  const saved = await save(path, content).then(
    () => true,
    () => false,
  );
  return {
    ...result,
    stdout: longOut ? keepEnds(result.stdout) : result.stdout,
    stderr: longErr ? keepEnds(result.stderr) : result.stderr,
    ...(saved ? { outputPath: path } : {}),
  };
}

/** The lines `read` returns by default. */
const defaultReadLines = 2_000;
/** The longest line `read` returns whole. */
const maxLineLength = 2_000;

/** A file read as text: its bytes decoded, or an error that suggests `shell` for a binary file. */
export function decodeText(bytes: Uint8Array, path: string): { text: string } | { error: string } {
  if (bytes.includes(0)) {
    return {
      error: `${path} is a binary file, which read can't show. Use ${shellToolName} to inspect it (for example file, xxd or strings).`,
    };
  }
  return { text: new TextDecoder().decode(bytes) };
}

/** Numbered lines of `text` from line `offset` (1-based), at most `limit` of them. */
export function readLines(text: string, offset = 1, limit = defaultReadLines) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = Math.max(offset, 1);
  const shown = lines.slice(start - 1, start - 1 + Math.max(limit, 0));
  const content = shown
    .map((line, index) => {
      const cut = line.length > maxLineLength ? `${line.slice(0, maxLineLength)}…` : line;
      return `${start + index}\t${cut}`;
    })
    .join("\n");
  const next = start + shown.length;
  return next <= lines.length
    ? { content, totalLines: lines.length, nextOffset: next }
    : { content, totalLines: lines.length };
}

const pathField = z.string().meta({ description: "Absolute, or relative to your own directory." });

export const readDefinition = toolDefinition({
  name: "read",
  description:
    `Read a text file from your computer, as numbered lines. By default it returns the first ` +
    `${defaultReadLines} lines, with lines over ${maxLineLength} characters cut; if more remains ` +
    "it gives the nextOffset to read from.",
  inputSchema: z.object({
    path: pathField,
    offset: z.number().int().optional().meta({ description: "The line to start at, from 1." }),
    limit: z.number().int().optional().meta({ description: "The most lines to return." }),
  }),
});

export const writeDefinition = toolDefinition({
  name: "write",
  description:
    "Write a file on your computer, creating any missing parent directories and overwriting the " +
    "file if it exists.",
  inputSchema: z.object({ path: pathField, content: z.string() }),
});

export const editDefinition = toolDefinition({
  name: "edit",
  description:
    "Replace exact text in a file on your computer. It fails when oldText is missing, or appears " +
    "more than once and replaceAll is not set.",
  inputSchema: z.object({
    path: pathField,
    oldText: z.string(),
    newText: z.string(),
    replaceAll: z.boolean().optional().meta({ description: "Replace every occurrence." }),
  }),
});

export const listDefinition = toolDefinition({
  name: "list",
  description:
    "List a directory on your computer, one level deep: each entry's name, kind (file or " +
    "directory) and size in bytes, sorted by name. Defaults to your own directory.",
  inputSchema: z.object({ path: pathField.optional() }),
});

/** The `read` tool's result. */
export async function readTool(
  computer: ComputerHandle,
  botId: string,
  input: { path: string; offset?: number; limit?: number },
) {
  const path = resolvePath(botId, input.path);
  const bytes = await computer.readFile(path);
  if (!bytes) return { error: `${path} does not exist. Use list to see what is there.` };
  const decoded = decodeText(bytes, path);
  if ("error" in decoded) return decoded;
  return readLines(decoded.text, input.offset, input.limit);
}

/** The `write` tool's result. */
export async function writeTool(
  computer: ComputerHandle,
  botId: string,
  input: { path: string; content: string },
) {
  const path = resolvePath(botId, input.path);
  await computer.writeFile(path, input.content);
  return { path, bytes: new TextEncoder().encode(input.content).length };
}

/** The `edit` tool's result: read plus write. */
export async function editTool(
  computer: ComputerHandle,
  botId: string,
  input: { path: string; oldText: string; newText: string; replaceAll?: boolean },
) {
  const path = resolvePath(botId, input.path);
  const bytes = await computer.readFile(path);
  if (!bytes) return { error: `${path} does not exist. Use write to create it.` };
  const decoded = decodeText(bytes, path);
  if ("error" in decoded) return decoded;
  if (!input.oldText) return { error: "oldText is empty. Give the exact text to replace." };
  const found = decoded.text.split(input.oldText).length - 1;
  if (found === 0) {
    return {
      error: `oldText was not found in ${path}. Read the file and give the text exactly as it is, including whitespace.`,
    };
  }
  if (found > 1 && !input.replaceAll) {
    return {
      error: `oldText appears ${found} times in ${path}. Add surrounding text to make it unique, or set replaceAll to replace every occurrence.`,
    };
  }
  await computer.writeFile(path, decoded.text.split(input.oldText).join(input.newText));
  return { path, replaced: input.replaceAll ? found : 1 };
}

/** The `list` tool's result. */
export async function listTool(computer: ComputerHandle, botId: string, input: { path?: string }) {
  const path = resolvePath(botId, input.path);
  const entries = await computer.list(path);
  if (!entries) return { error: `${path} does not exist.` };
  return { path, entries: entries.toSorted((a, b) => a.name.localeCompare(b.name)) };
}
