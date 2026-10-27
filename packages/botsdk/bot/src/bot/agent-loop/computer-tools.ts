import { posix } from "node:path";

import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

import type { BotSdkContext } from "../../plugin";
import {
  type ComputerHandle,
  defaultCommandTimeoutMs,
  type Rebuild,
} from "../../computer/internal";
import { isSkillFile } from "../skill-files";
import { botDirectory, resolvePath, sharedDirectory } from "../conversation";
import type { CommandResult, TimedOutCommand } from "../../computer/internal";

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

/** What a tool returns when the Computer failed its operation, with the Computer's own message. */
export function computerOperationError(message: string): string {
  return `Your computer reported an error: ${message}`;
}

/**
 * What a Bot's first tool result after a rebuild of the Computer adds, once per Bot. Once a later
 * sync replaced the archive, the row no longer says whether the rebuild restored any files, so
 * the note claims none.
 */
export function rebuiltNote({ rebuiltAt, restoredAsOf }: Rebuild): string {
  if (restoredAsOf === undefined) {
    return `Your computer was rebuilt at ${rebuiltAt.toISOString()}: it got back at most the files it had saved before then, maybe none, and installed programs may be missing.`;
  }
  return restoredAsOf
    ? `Your computer was rebuilt: files were restored as of ${restoredAsOf.toISOString()}, but installed programs may be missing.`
    : "Your computer was rebuilt: it had no saved files to restore, and installed programs may be missing.";
}

/** What a resumed Turn returns for a `shell` call that started but has no result. */
export const interruptedShellError =
  "This command was interrupted by a restart and may have partly run. Check its effects before " +
  "running it again.";

/** What a `shell` call killed at its time limit adds to the output it printed. */
export const timedOutHint =
  "The command was killed at its time limit. Break the work up into shorter commands, or give a " +
  "longer timeoutSeconds if this turn has time left.";

/** The user's Computer. Call it only with the computer slot set (`deps.computer`). */
export function computerOf(deps: BotSdkContext, userId: string): ComputerHandle {
  if (!deps.computer) throw new Error("The computer slot isn't set");
  return deps.computer.forUser(userId);
}

/**
 * The cheapest-first ladder in the Computer system prompt (spec #587, #573), word for word. The
 * rungs are what the Bot knows or has in its files, `web_search`, then a Helper. With
 * `withConnectors` (the Host installs `mcp`, spec #801), the Bot's connectors are rung 2, before
 * `web_search`. It sits in the stable prefix, so it is the same on every Turn.
 */
export function ladderPrompt(withConnectors: boolean): string {
  const connectors = withConnectors
    ? "then your connectors (the deferred tools of the services the user connected), "
    : "";
  return (
    `Try the cheapest way first: what you already know or have in your files, ${connectors}then ` +
    "`web_search`, then a Helper. " +
    (withConnectors
      ? "If a connector is broken, tell the user and ask; don't use the browser. "
      : "") +
    "If you can do it yourself in a few tool calls, do it. Hand anything bigger to a " +
    "Helper with `start_helper` so you can keep talking to the user: a general Helper for shell, " +
    "files and web search; a computer-use Helper when it needs a website or app. Write the task so " +
    "it stands alone, since the Helper sees nothing else. Its report comes back to you; tell the " +
    "user what matters in it. Your to-do list shows the Helpers still working or waiting for the " +
    "user. If a tool is broken, tell the user and ask; never work around it with a browser."
  );
}

/**
 * What the system prompt says about the Computer, with the Bot's own directory in it, and the
 * ladder with connectors when `withConnectors`.
 */
export function computerPrompt(botId: string, withConnectors: boolean): string {
  return (
    "You have a computer: a Linux machine you share with the user's other Bots. Run commands on " +
    `it with the ${shellToolName} tool. Your own directory is ${botDirectory(botId)}: commands run ` +
    "there unless you give another cwd, so keep your files there. The user's Bots share " +
    `${sharedDirectory}, to hand files to each other. Keep to your own directory and the shared ` +
    "one, and don't change other Bots' files. The user never sees the computer: tell them what " +
    "you did through your messages. " +
    ladderPrompt(withConnectors)
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
    secrets: z
      .array(z.string())
      .optional()
      .meta({
        description:
          "Names of the user's Secrets this command needs. Each one is set as an environment " +
          "variable of this command only, so refer to it as $NAME. Its value is never shown to you.",
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

/** What a cut text says when the Bot has no Computer to hold the rest. */
export const notSavedNote = "The rest was not saved.";

/**
 * Text over `spillThreshold` characters, cut to its first and last characters, with the full text
 * saved at `path` by `save` and the note that says where. With no `save` (no Computer), or when it
 * fails, the note says the rest was not saved. Shorter text comes back whole.
 */
export async function capText(
  text: string,
  path: string,
  save?: (path: string, content: string) => Promise<void>,
): Promise<string> {
  if (text.length <= spillThreshold) return text;
  // The text exists already, so a failed save must not fail the call: it goes without the file.
  const saved = save
    ? await save(path, text).then(
        () => true,
        () => false,
      )
    : false;
  return `${keepEnds(text)}\n${saved ? `The full text is saved at ${path}.` : notSavedNote}`;
}

/**
 * A tool's result as the Model reads it: JSON over `spillThreshold` characters becomes its cut
 * text (see `capText`), anything else stays as it is.
 */
/** Whether `capResult` cuts `result`: its JSON is over `spillThreshold` characters. */
export function isLong(result: unknown): boolean {
  const text = JSON.stringify(result);
  return text !== undefined && text.length > spillThreshold;
}

export async function capResult<T>(
  result: T,
  path: string,
  save?: (path: string, content: string) => Promise<void>,
): Promise<T | string> {
  const text = JSON.stringify(result);
  if (text === undefined || text.length <= spillThreshold) return result;
  return capText(text, path, save);
}

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

/**
 * A file read as text: its bytes decoded as UTF-8, with any byte order mark kept so an edit writes
 * it back, or an error that suggests `shell` for a binary file or one that isn't UTF-8 (which a
 * rewrite would corrupt).
 */
export function decodeText(bytes: Uint8Array, path: string): { text: string } | { error: string } {
  if (bytes.includes(0)) return { error: binaryFileError(path) };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { error: notUtf8Error(path) };
  }
}

const binaryFileError = (path: string) =>
  `${path} is a binary file, which read can't show. Use ${shellToolName} to inspect it (for example file, xxd or strings).`;

const notUtf8Error = (path: string) =>
  `${path} is not UTF-8 text, which read and edit can't handle without changing it. Use ${shellToolName} to inspect or change it (for example file, iconv or sed).`;

/** The most bytes of a file that `edit` loads. Over it, edit returns an error that suggests `shell`. */
export const maxTextBytes = 5_000_000;

/** The most characters of numbered lines one `read` returns. */
export const maxPageCharacters = 10_000;

/** The most bytes of lines one `read` fetches: enough for a full page of 4-byte characters. */
export const maxFetchedBytes = 4 * maxPageCharacters;

/**
 * How much of each line `read` fetches, in bytes: `maxLineLength` characters of up to 4 bytes,
 * and one more, so a line cut here is still cut with "…".
 */
export const fetchedLineBytes = 4 * (maxLineLength + 1);

/** What a file tool's operations get from the Turn: its Stop, and its time limit (for its commands). */
export type FileToolOptions = { signal?: AbortSignal; deadline?: Date };

/** A path quoted for bash. */
const quote = (path: string) => `'${path.replaceAll("'", String.raw`'\''`)}'`;

/** Reports what the path in `$p` is when it isn't a regular file, and ends the command. */
const notRegular = [
  `[ -e "$p" ] || { echo missing; exit 0; }`,
  `[ -d "$p" ] && { echo directory; exit 0; }`,
  `[ -f "$p" ] || { echo special; exit 0; }`,
].join("\n");

/**
 * `read`'s one command, after `p=<path> o=<first line> n=<lines>`. Unless the path isn't a regular
 * file, it reports `binary` or `notutf8` from the whole file (two passes on the Computer, so no
 * byte moves), or else `lines <count>` and then the range, base64: each line cut to
 * `fetchedLineBytes`, and only the lines that fit in `maxFetchedBytes`. Any failed step fails the
 * command. The UTF-8 check needs the C.UTF-8 locale (Debian has it); without it, only the
 * fetched lines are checked.
 */
export const readScript = [
  "set -o pipefail",
  notRegular,
  // One pass counts the newlines and the NULs: tr keeps only those, and wc counts them.
  String.raw`counts=$(tr -dc '\000\n' < "$p" | wc -lc) || exit`,
  `read -r lines all <<< "$counts"`,
  `[ "$all" -eq "$lines" ] || { echo binary; exit 0; }`,
  `LC_ALL=C.UTF-8 grep -qaxv '.*' "$p"; s=$?`,
  `[ $s -eq 0 ] && { echo notutf8; exit 0; }`,
  `[ $s -eq 1 ] || exit $s`,
  `[ -n "$(tail -c 1 "$p")" ] && lines=$((lines + 1))`,
  `echo "lines $lines"`,
  `e=$((o + n - 1)); [ "$e" -gt "$lines" ] && e=$lines`,
  `[ "$n" -gt 0 ] && [ "$o" -le "$e" ] || exit 0`,
  `sed -n "$o,\${e}p;\${e}q" "$p" | cut -b 1-${fetchedLineBytes} | LC_ALL=C awk -v max=${maxFetchedBytes} '!cut { if (t + length($0) + 1 > max) cut = 1; else { t += length($0) + 1; print } }' | base64 -w0`,
].join("\n");

/** `edit`'s look-up, after `p=<path>`: unless the path isn't a regular file, `bytes <size>`. */
export const sizeScript = [notRegular, `b=$(wc -c < "$p") || exit`, `echo "bytes $b"`].join("\n");

/** A whole number at least `min`, or the largest safe one for a larger number. */
function wholeAtLeast(value: number, min: number): number {
  const whole = Math.trunc(value);
  if (Number.isSafeInteger(whole)) return Math.max(whole, min);
  return whole > 0 ? Number.MAX_SAFE_INTEGER : min;
}

/** What a file tool's command reports on its own line: the path's kind, or what it found. */
const reportLine = /^(missing|directory|special|binary|notutf8|lines \d+|bytes \d+)$/;

/**
 * Runs a file tool's command on `path` and returns its report and the output after it, or an
 * error: `missing` when there is no such file, one for a directory or another kind of file, and
 * what the Computer said when the command failed (a permission denied).
 */
async function runOnFile(
  computer: ComputerHandle,
  path: string,
  command: string,
  missing: string,
  options: FileToolOptions,
): Promise<{ report: string; rest: string } | { error: string }> {
  const result = await computer.run(command, options);
  if ("timedOut" in result) {
    return { error: `Looking at ${path} timed out. Use ${shellToolName} to work with it.` };
  }
  if (result.exitCode !== 0) {
    return {
      error: computerOperationError(result.stderr.trim() || `exit code ${result.exitCode}`),
    };
  }
  // The report is the last such line: a login profile may print before it.
  const lines = result.stdout.split("\n");
  let at = lines.length - 1;
  while (at >= 0 && !reportLine.test(lines[at]!)) at--;
  const report = lines[at];
  if (report === undefined) {
    return { error: computerOperationError(`unexpected output: ${result.stdout.slice(0, 200)}`) };
  }
  if (report === "missing") return { error: missing };
  if (report === "directory") {
    return { error: `${path} is a directory. Use list to see what is there.` };
  }
  if (report === "special") {
    return { error: `${path} is not a regular file. Use ${shellToolName} to work with it.` };
  }
  return { report, rest: lines.slice(at + 1).join("\n") };
}

/**
 * The fetched lines, with the end of each line cut at `fetchedLineBytes` dropped when the cut
 * split a character, so the cut alone never makes the text look like it isn't UTF-8.
 */
function dropSplitCharacters(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline;
    const cut = end - start === fetchedLineBytes ? splitTail(bytes, start, end) : 0;
    parts.push(bytes.subarray(start, end - cut));
    if (newline >= 0) parts.push(Uint8Array.of(10));
    start = end + 1;
  }
  return Buffer.concat(parts);
}

/** How many bytes at the end of `bytes[start, end)` are an incomplete UTF-8 character. */
function splitTail(bytes: Uint8Array, start: number, end: number): number {
  for (let back = 1; back <= 3 && end - back >= start; back += 1) {
    const byte = bytes[end - back] ?? 0;
    // A continuation byte: the character starts further back.
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? back : 0;
  }
  return 0;
}

/**
 * Numbered lines from `rangeText`, which holds the file's lines from line `start` (1-based) on, out
 * of `totalLines`. The page keeps the lines that fit in `maxPageCharacters` (the first always
 * does), and `nextOffset` is the line after them when more remains.
 */
export function numberLines(rangeText: string, start: number, totalLines: number) {
  const lines = rangeText.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const page: string[] = [];
  let size = 0;
  for (const [index, line] of lines.entries()) {
    const cut = line.length > maxLineLength ? `${line.slice(0, maxLineLength)}…` : line;
    const numbered = `${start + index}\t${cut}`;
    // The newline joining it to the line before counts too.
    if (page.length > 0 && size + 1 + numbered.length > maxPageCharacters) break;
    size += (page.length > 0 ? 1 : 0) + numbered.length;
    page.push(numbered);
  }
  const content = page.join("\n");
  const next = start + page.length;
  return next <= totalLines ? { content, totalLines, nextOffset: next } : { content, totalLines };
}

const pathField = z.string().meta({ description: "Absolute, or relative to your own directory." });

export const readDefinition = toolDefinition({
  name: "read",
  description:
    `Read a text file from your computer, as numbered lines. By default it returns the first ` +
    `${defaultReadLines} lines, with lines over ${maxLineLength} characters cut, and at most ` +
    `${maxPageCharacters} characters; if more remains it gives the nextOffset to read from.`,
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

/**
 * The Computer tools a Bot is given, in the order its Prompt start sends them: the loop builds its
 * tools in this order, and an away Summary sends these definitions when it builds a Prompt start.
 */
export const computerToolDefinitions = [
  shellDefinition,
  readDefinition,
  writeDefinition,
  editDefinition,
  listDefinition,
];

/**
 * The `read` tool's result, from one command on the Computer: it checks the whole file there and
 * fetches only the lines it returns, with `sed`, so paging through a huge file doesn't move the
 * file. A page whose lines are over `maxPageCharacters` stops early, with a hint to read on.
 */
export async function readTool(
  computer: ComputerHandle,
  botId: string,
  input: { path: string; offset?: number; limit?: number },
  options: FileToolOptions = {},
  mask: (text: string) => string = (text) => text,
) {
  const path = resolvePath(botId, input.path);
  const start = wholeAtLeast(input.offset ?? 1, 1);
  const count = wholeAtLeast(input.limit ?? defaultReadLines, 0);
  const found = await runOnFile(
    computer,
    path,
    `p=${quote(path)} o=${start} n=${count}\n${readScript}`,
    `${path} does not exist. Use list to see what is there.`,
    options,
  );
  if ("error" in found) return found;
  if (found.report === "binary") return { error: binaryFileError(path) };
  if (found.report === "notutf8") return { error: notUtf8Error(path) };
  const totalLines = Number(found.report.slice("lines ".length));
  const bytes = dropSplitCharacters(Buffer.from(found.rest.trim(), "base64"));
  const decoded = decodeText(bytes, path);
  if ("error" in decoded) return decoded;
  // Masked of the user's Secrets before a long line is cut, so a value is never half kept by it.
  const page = numberLines(mask(decoded.text), start, totalLines);
  const nextOffset = "nextOffset" in page ? page.nextOffset : undefined;
  if (nextOffset === undefined || nextOffset > Math.min(start + count - 1, totalLines)) return page;
  return {
    ...page,
    hint:
      `This read stopped before line ${nextOffset}: one read returns at most ${maxPageCharacters} characters. ` +
      `Read on with offset ${nextOffset}, or use ${shellToolName} (for example sed, head or grep).`,
  };
}

/** The `write` tool's result. */
export async function writeTool(
  computer: ComputerHandle,
  botId: string,
  input: { path: string; content: string },
  options: FileToolOptions = {},
) {
  const path = resolvePath(botId, input.path);
  // A new Skill is told apart from a changed one, for the Turn's Skill chip (spec #713).
  const created = isSkillFile(botId, path) && !(await computer.readFile(path, options));
  await computer.writeFile(path, input.content, options);
  return {
    path,
    bytes: new TextEncoder().encode(input.content).length,
    ...(created && { created }),
  };
}

/** The `edit` tool's result: a size look-up, a load, and a write. */
export async function editTool(
  computer: ComputerHandle,
  botId: string,
  input: { path: string; oldText: string; newText: string; replaceAll?: boolean },
  options: FileToolOptions = {},
) {
  const path = resolvePath(botId, input.path);
  const missing = `${path} does not exist. Use write to create it.`;
  const looked = await runOnFile(
    computer,
    path,
    `p=${quote(path)}\n${sizeScript}`,
    missing,
    options,
  );
  if ("error" in looked) return looked;
  const size = Number(looked.report.slice("bytes ".length));
  if (size > maxTextBytes) {
    return {
      error: `${path} is ${size} bytes, over the ${maxTextBytes} edit can load. Use ${shellToolName} to change it (for example sed or a script).`,
    };
  }
  const bytes = await computer.readFile(path, options);
  if (!bytes) return { error: missing };
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
  await computer.writeFile(path, decoded.text.split(input.oldText).join(input.newText), options);
  return { path, replaced: input.replaceAll ? found : 1 };
}

/**
 * The `list` tool's result. The Bot's own directory exists from its first write, so before that
 * it lists as empty.
 */
export async function listTool(
  computer: ComputerHandle,
  botId: string,
  input: { path?: string },
  options: FileToolOptions = {},
) {
  const path = resolvePath(botId, input.path);
  const entries = await computer.list(path, options);
  if (!entries && path === botDirectory(botId)) return { path, entries: [] };
  if (!entries) return { error: `${path} does not exist.` };
  return { path, entries: [...entries].sort((a, b) => a.name.localeCompare(b.name)) };
}
