import { randomBytes } from "node:crypto";
import { posix } from "node:path";

import {
  SandboxGoneError,
  type CommandResult,
  type ComputerProvider,
  type FileEntry,
  type TimedOutCommand,
} from "@botsdk/bot/computer/internal";
import {
  fetchedLineBytes,
  maxFetchedBytes,
  readScript,
  sizeScript,
} from "@botsdk/bot/bot/agent-loop";
import { boundedOutput } from "../../plugins/computer/e2b/bounded-output";
import { stampScript, walkScript } from "../../plugins/knowledge/server/files";
import { readSkillsScript, skillHeadBytes } from "../../plugins/skills/server/skills";

/** One command the fake ran: where, on which sandbox, and with what time limit. */
export type FakeCommand = {
  sandboxId: string;
  command: string;
  cwd: string | undefined;
  timeoutMs: number;
  /** The environment variables the command was given, when it was given any. */
  envs?: Record<string, string>;
};

/**
 * What `onCommand` gets for a command: `print` adds to its stdout so far, which a timeout returns,
 * and `signal` aborts once the command is killed.
 */
export type FakeCommandRun = FakeCommand & { print: (stdout: string) => void; signal: AbortSignal };

type Lifecycle = "create" | "resume";

/**
 * What the fake was asked to do, in order. A kill is of a running command, a kill-sandbox of a
 * whole sandbox, and a pause is recorded only once it succeeded.
 */
export type FakeCall =
  | { [Type in Lifecycle]: { type: Type; sandboxId: string; timeoutMs: number } }[Lifecycle]
  | { type: "endpoint"; sandboxId: string; port: number }
  | { type: "pause"; sandboxId: string }
  | { type: "timeout"; sandboxId: string; timeoutMs: number }
  | ({ type: "run" } & FakeCommand)
  | { type: "kill"; sandboxId: string; command: string }
  | { type: "kill-sandbox"; sandboxId: string };

/**
 * One sandbox's disk: each file's bytes, the write that last changed it as its mtime, and the
 * files its commands can't read (permission denied).
 */
type Disk = {
  files: Map<string, Uint8Array>;
  mtimes: Map<string, number>;
  unreadable: Set<string>;
};

/** Every fake disk's write count, so no two writes of a file share an mtime. */
let stamps = 0;

/** A disk whose every file set, a test's own included, stamps the file's mtime as a write does. */
function newDisk(): Disk {
  const mtimes = new Map<string, number>();
  class StampedFiles extends Map<string, Uint8Array> {
    override set(path: string, bytes: Uint8Array) {
      mtimes.set(path, ++stamps);
      return super.set(path, bytes);
    }
  }
  return { files: new StampedFiles(), mtimes, unreadable: new Set() };
}

/** A result with each stream kept as the E2B adapter keeps it: 1 MiB characters at each end. */
function bounded<Result extends CommandResult | TimedOutCommand>(result: Result): Result {
  const out = boundedOutput();
  const err = boundedOutput();
  out.add(result.stdout);
  err.add(result.stderr);
  return { ...result, stdout: out.text(), stderr: err.text() };
}

/**
 * A Computer provider for tests: no sandbox, only a record of what it was asked to do, and a disk
 * per sandbox. Each command is answered by `onCommand`, which the test supplies (exit 0 with no
 * output by default), except the commands the sync and restore use (`mkdir -p`, `find … -prune`, `rm -f`,
 * `tar -czf`, `tar -xzf`, `stat -c %s`, joined by `&&`), the file tools' commands, the Skills read
 * and the Knowledge walk, which the fake runs on the disk. Its archives are uncompressed, so a file's size is its archive's. Each
 * command's output is kept as the E2B adapter keeps it, and a file in `unreadable` fails the file
 * tools' commands with permission denied.
 *
 * A command still running after its `timeoutMs` is killed and returns what it printed; one whose
 * `signal` aborts is killed and throws. Each lifecycle call in `failing` throws, recording nothing.
 * Each pause first awaits `onPause`, so a test can hold a pause, or make it fail by throwing. A
 * command or file operation on a paused sandbox throws, so an operation that skipped its wake
 * fails. `lose(sandboxId)` makes a sandbox gone: its disk is dropped, a resume reports it gone, and
 * a command, file operation, pause or timeout on it throws `SandboxGoneError`. Reading a directory
 * or listing a file throws, as a real filesystem does.
 */
export function fakeComputerProvider({
  template = "fake-computer-v1",
  onCommand = () => ({ exitCode: 0, stdout: "", stderr: "" }),
  onPause = () => {},
  holds = () => false,
  hostUrl = (sandboxId, port) => `https://${port}-${sandboxId}.fake.test`,
}: {
  template?: string;
  /** The URL of a port of a sandbox: a test can point a Screen's DevTools port at a real Chromium. */
  hostUrl?: (sandboxId: string, port: number) => string;
  onCommand?: (command: FakeCommandRun) => CommandResult | Promise<CommandResult>;
  onPause?: (sandboxId: string) => void | Promise<void>;
  /** A command the fake does not answer itself: `onCommand` gets it, so a test can hold it until a kill. */
  holds?: (command: string) => boolean;
} = {}) {
  const calls: FakeCall[] = [];
  const failing = new Set<Lifecycle>();
  const failIfTold = (call: Lifecycle) => {
    if (failing.has(call)) throw new Error(`The fake was told to fail ${call}`);
  };
  const paused = new Set<string>();
  const disks = new Map<string, Disk>();
  // The newest sandbox's disk; before the first create, the disk that sandbox starts with.
  let current = newDisk();
  /** The disk of a sandbox that exists and isn't paused, so an operation that skipped its wake fails. */
  const runningDisk = (sandboxId: string) => {
    if (paused.has(sandboxId)) throw new Error(`Sandbox ${sandboxId} is paused`);
    const disk = disks.get(sandboxId);
    if (!disk) throw new SandboxGoneError(sandboxId);
    return disk;
  };
  // A real provider never hands out an id twice. A fake over a database that an earlier process
  // used (the memory eval's) would otherwise reuse its ids, and that process's queued sleep
  // checks would pause this one's sandboxes.
  const instance = randomBytes(4).toString("hex");
  let created = 0;
  const write = (disk: Disk, path: string, bytes: Uint8Array) => {
    disk.files.set(path, bytes);
  };
  const provider: ComputerProvider = {
    template,
    create: async ({ timeoutMs }) => {
      // A sandbox takes a moment to start, so operations that race a wake overlap it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      failIfTold("create");
      const sandboxId = `fake-sandbox-${instance}-${++created}`;
      // A sandbox built from the template starts with nothing of an earlier one's.
      if (created > 1) current = newDisk();
      disks.set(sandboxId, current);
      calls.push({ type: "create", sandboxId, timeoutMs });
      return { sandboxId };
    },
    endpoint: async (sandboxId, port) => {
      if (!disks.has(sandboxId)) throw new SandboxGoneError(sandboxId);
      calls.push({ type: "endpoint", sandboxId, port });
      // Each port's endpoint carries headers of its own, as the Embed's routing headers do.
      return {
        url: hostUrl(sandboxId, port),
        headers: { "e2b-traffic-access-token": `traffic-${sandboxId}`, "fake-port": String(port) },
      };
    },
    resume: async (sandboxId, { timeoutMs }) => {
      failIfTold("resume");
      if (!disks.has(sandboxId)) return "gone";
      paused.delete(sandboxId);
      calls.push({ type: "resume", sandboxId, timeoutMs });
      return "resumed";
    },
    kill: async (sandboxId) => {
      disks.delete(sandboxId);
      paused.delete(sandboxId);
      calls.push({ type: "kill-sandbox", sandboxId });
    },
    pause: async (sandboxId) => {
      await onPause(sandboxId);
      if (!disks.has(sandboxId)) throw new SandboxGoneError(sandboxId);
      // Pausing a paused sandbox succeeds, as the provider seam promises.
      paused.add(sandboxId);
      calls.push({ type: "pause", sandboxId });
    },
    setTimeout: async (sandboxId, timeoutMs) => {
      if (!disks.has(sandboxId)) throw new SandboxGoneError(sandboxId);
      calls.push({ type: "timeout", sandboxId, timeoutMs });
    },
    run: async (sandboxId, command, { cwd, timeoutMs, signal, envs }) => {
      const disk = runningDisk(sandboxId);
      calls.push({ type: "run", sandboxId, command, cwd, timeoutMs, ...(envs && { envs }) });
      const builtIn = holds(command)
        ? undefined
        : runBuiltIn(disk, command, cwd ?? "/home/user", write);
      if (builtIn) return bounded(builtIn);
      const killed = new AbortController();
      let stdout = "";
      const result = await new Promise<CommandResult | TimedOutCommand>((resolve, reject) => {
        /** Settles the command once: a kill first records it and stops `onCommand`. */
        const settle = (kill: boolean, finish: () => void) => {
          if (killed.signal.aborted) return;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (kill) calls.push({ type: "kill", sandboxId, command });
          killed.abort();
          finish();
        };
        const timer = setTimeout(
          () => settle(true, () => resolve({ timedOut: true, stdout, stderr: "" })),
          timeoutMs,
        );
        const onAbort = () => settle(true, () => reject(signal?.reason));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        const print = (text: string) => {
          stdout += text;
        };
        Promise.resolve()
          .then(() =>
            onCommand({
              sandboxId,
              command,
              cwd,
              timeoutMs,
              ...(envs && { envs }),
              signal: killed.signal,
              print,
            }),
          )
          .then(
            (result) => settle(false, () => resolve(result)),
            (caught) => settle(false, () => reject(caught)),
          );
      });
      return bounded(result);
    },
    readFile: async (sandboxId, path) => {
      const { files } = runningDisk(sandboxId);
      if (isDirectory(files, path)) throw new Error(`EISDIR: ${path} is a directory`);
      return files.get(path) ?? null;
    },
    writeFile: async (sandboxId, path, content) => {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      write(runningDisk(sandboxId), path, bytes);
    },
    list: async (sandboxId, path) => {
      const { files } = runningDisk(sandboxId);
      if (files.has(path)) throw new Error(`ENOTDIR: ${path} is not a directory`);
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = new Map<string, FileEntry>();
      for (const [file, bytes] of files) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split("/");
        if (!name) continue;
        entries.set(
          name,
          rest.length > 0
            ? { name, kind: "directory", size: 0 }
            : { name, kind: "file", size: bytes.length },
        );
      }
      return entries.size > 0 ? [...entries.values()] : null;
    },
  };
  /** The calls of one type. */
  const callsOf = <Type extends FakeCall["type"]>(type: Type) =>
    calls.filter((call): call is Extract<FakeCall, { type: Type }> => call.type === type);
  /** Makes a sandbox gone, as when its snapshot is lost: a resume then reports it gone. */
  const lose = (sandboxId: string) => {
    disks.delete(sandboxId);
    paused.delete(sandboxId);
  };
  return {
    provider,
    calls,
    callsOf,
    failing,
    lose,
    /** The files of the newest sandbox (before the first create, those it starts with), by path. */
    get files() {
      return current.files;
    },
    /** The files of the newest sandbox that its commands can't read, as with permission denied. */
    get unreadable() {
      return current.unreadable;
    },
  };
}

/**
 * Runs a command the sync and restore use on `disk`, or returns undefined for any other command,
 * which `onCommand` answers. Each `&&` part must be one of those commands; one that fails ends the
 * chain with exit 1.
 */
function runBuiltIn(
  disk: Disk,
  command: string,
  cwd: string,
  write: (disk: Disk, path: string, bytes: Uint8Array) => void,
): CommandResult | undefined {
  const fileTool = fileToolCommand(disk, command, cwd);
  if (fileTool) return fileTool;
  const skills = readSkillsCommand(disk, command);
  if (skills) return skills;
  const knowledge = knowledgeWalkCommand(disk, command) ?? knowledgeStampCommand(disk, command);
  if (knowledge) return knowledge;
  // tar's `|| [ $? -eq 1 ]` (its exit 1 still wrote the archive) never fails here.
  const parts = command.replaceAll(" || [ $? -eq 1 ]", "").split(" && ").map(words);
  if (!parts.every(isBuiltIn)) return undefined;
  const at = (path: string) => posix.resolve(cwd, path);
  const under = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
  let stdout = "";
  for (const [name, ...args] of parts) {
    if (name === "mkdir") continue;
    if (name === "find") {
      // find <roots…> -name <excluded> -prune -o ! -type d -printf '%p %s %Ts\n'
      const roots = args.slice(0, args.indexOf("-name"));
      const excluded = args[args.indexOf("-name") + 1];
      for (const root of roots) {
        for (const [path, bytes] of disk.files) {
          if (!under(at(root), path)) continue;
          const relative = posix.join(root, posix.relative(at(root), path));
          if (relative.split("/").includes(excluded ?? "")) continue;
          stdout += `${relative} ${bytes.length} ${disk.mtimes.get(path) ?? 0}\n`;
        }
      }
      continue;
    }
    if (name === "rm") {
      disk.files.delete(at(args.at(-1) ?? ""));
      continue;
    }
    if (name === "stat") {
      const bytes = disk.files.get(at(args.at(-1) ?? ""));
      if (!bytes) return { exitCode: 1, stdout, stderr: "stat: no such file" };
      stdout += `${bytes.length}\n`;
      continue;
    }
    if (name === "tar" && args[0] === "-czf") {
      // tar -czf <archive> [--exclude=<name>]… <roots…>
      const excluded = args
        .filter((arg) => arg.startsWith("--exclude="))
        .map((arg) => arg.slice(10));
      const roots = args.slice(1).filter((arg) => !arg.startsWith("--exclude="));
      const members: [string, Uint8Array][] = [];
      for (const [path, bytes] of disk.files) {
        const root = roots.find((candidate) => under(at(candidate), path));
        if (!root) continue;
        const relative = posix.relative(cwd, path);
        if (relative.split("/").some((segment) => excluded.includes(segment))) continue;
        members.push([relative, bytes]);
      }
      write(disk, at(args[1] ?? ""), packArchive(members));
      continue;
    }
    if (name === "tar" && args[0] === "-xzf") {
      // tar -xzf <archive> -C <directory>
      const archive = disk.files.get(at(args[1] ?? ""));
      const members = archive && unpackArchive(archive);
      if (!members) return { exitCode: 2, stdout, stderr: "tar: not an archive" };
      const into = at(args[args.indexOf("-C") + 1] ?? ".");
      for (const [relative, bytes] of members) write(disk, posix.join(into, relative), bytes);
      continue;
    }
    return { exitCode: 1, stdout, stderr: `fake: unsupported ${name} ${args.join(" ")}` };
  }
  return { exitCode: 0, stdout, stderr: "" };
}

/** Whether `path` is a directory of `files`: some file is under it. */
const isDirectory = (files: Map<string, Uint8Array>, path: string) => {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  return [...files.keys()].some((file) => file.startsWith(prefix));
};

const builtIns = new Set(["mkdir", "find", "rm", "stat", "tar"]);

/** A file's lines (without their newlines), and whether the last one ends with a newline. */
function lineParts(bytes: Uint8Array) {
  const lines = Buffer.from(bytes).toString("latin1").split("\n");
  const terminated = lines.at(-1) === "";
  if (terminated) lines.pop();
  return { lines, terminated };
}

/**
 * Runs a file tool's command on `disk` as bash would: `p=<path> o=<first line> n=<lines>` then
 * `readScript`, or `p=<path>` then `sizeScript`. Returns undefined for any other command.
 */
function fileToolCommand(disk: Disk, command: string, cwd: string): CommandResult | undefined {
  const newline = command.indexOf("\n");
  const body = command.slice(newline + 1);
  if (body !== readScript && body !== sizeScript) return undefined;
  const match = /^p='((?:[^']|'\\'')*)'(?: o=(\d+) n=(\d+))?$/.exec(command.slice(0, newline));
  if (!match) return undefined;
  const [, quoted, from, count] = match;
  const path = posix.resolve(cwd, (quoted ?? "").replaceAll(String.raw`'\''`, "'"));
  const report = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
  const bytes = disk.files.get(path);
  if (!bytes) return report(isDirectory(disk.files, path) ? "directory\n" : "missing\n");
  if (disk.unreadable.has(path)) {
    return { exitCode: 1, stdout: "", stderr: `bash: line 5: ${path}: Permission denied` };
  }
  if (body === sizeScript) return report(`bytes ${bytes.length}\n`);
  if (bytes.includes(0)) return report("binary\n");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return report("notutf8\n");
  }
  const { lines } = lineParts(bytes);
  const header = `lines ${lines.length}\n`;
  const first = Number(from);
  const last = Math.min(first + Number(count) - 1, lines.length);
  if (Number(count) === 0 || first > last) return report(header);
  // Each line cut to its fetched bytes, and only the lines that fit in a page.
  let page = "";
  for (const line of lines.slice(first - 1, last)) {
    const cut = line.slice(0, fetchedLineBytes);
    if (page.length + cut.length + 1 > maxFetchedBytes) break;
    page += `${cut}\n`;
  }
  return report(header + Buffer.from(page, "latin1").toString("base64"));
}

/**
 * Runs `readBotSkills`' command on `disk` as bash would: `d=<Skills folder>` then
 * `readSkillsScript`. Returns undefined for any other command.
 */
function readSkillsCommand(disk: Disk, command: string): CommandResult | undefined {
  const newline = command.indexOf("\n");
  if (command.slice(newline + 1) !== readSkillsScript) return undefined;
  const match = /^d='((?:[^']|'\\'')*)'$/.exec(command.slice(0, newline));
  if (!match) return undefined;
  const directory = (match[1] ?? "").replaceAll(String.raw`'\''`, "'");
  const folders = new Set<string>();
  for (const path of disk.files.keys()) {
    const [folder, ...rest] = path.slice(directory.length + 1).split("/");
    if (path.startsWith(`${directory}/`) && folder && rest.length > 0) folders.add(folder);
  }
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  /** The lines up to the second `---` line, of the first `skillHeadBytes` bytes, as awk prints them. */
  const frontmatter = (bytes: Uint8Array) => {
    let printed = "";
    let marks = 0;
    for (const line of lineParts(bytes.subarray(0, skillHeadBytes)).lines) {
      printed += `${line}\n`;
      if (/^\s*---\s*$/.test(line) && ++marks === 2) break;
    }
    return Buffer.from(printed, "latin1");
  };
  let stdout = "";
  for (const folder of folders) {
    const path = `${directory}/${folder}/SKILL.md`;
    const bytes = disk.files.get(path);
    const state = bytes
      ? disk.unreadable.has(path)
        ? "unreadable"
        : `file ${base64(frontmatter(bytes))}`
      : isDirectory(disk.files, path)
        ? "unreadable"
        : "none";
    stdout += `${base64(new TextEncoder().encode(folder))} ${state}\n`;
  }
  return { exitCode: 0, stdout, stderr: "" };
}

/**
 * Runs the Knowledge walk's command on `disk` as bash would: `d=<folder>` then `walkScript`. A
 * folder is any directory a file is under (the fake keeps no empty ones). Returns undefined for any
 * other command.
 */
function knowledgeWalkCommand(disk: Disk, command: string): CommandResult | undefined {
  const newline = command.indexOf("\n");
  if (command.slice(newline + 1) !== walkScript) return undefined;
  const match = /^d='((?:[^']|'\\'')*)'$/.exec(command.slice(0, newline));
  if (!match) return undefined;
  const directory = (match[1] ?? "").replaceAll(String.raw`'\''`, "'");
  const folders = new Set<string>();
  let listing = "";
  let total = 0;
  for (const [path, bytes] of disk.files) {
    if (!path.startsWith(`${directory}/`)) continue;
    const relative = path.slice(directory.length + 1);
    const segments = relative.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      folders.add(segments.slice(0, depth).join("/"));
    }
    listing += `f ${bytes.length} ${disk.mtimes.get(path) ?? 0} ${relative}\0`;
    total += bytes.length;
  }
  if (!listing) return { exitCode: 0, stdout: "", stderr: "" };
  for (const folder of folders) listing += `d 0 0 ${folder}\0`;
  const raw = Buffer.from(listing);
  return {
    exitCode: 0,
    stdout: `${raw.toString("base64")}\n${total}\n${raw.length}\n`,
    stderr: "",
  };
}

/**
 * Runs the Knowledge stamp's command on `disk`: `p=<path>` then `stampScript`, printing the file's
 * mtime and size as the walk does. Returns undefined for any other command.
 */
function knowledgeStampCommand(disk: Disk, command: string): CommandResult | undefined {
  const newline = command.indexOf("\n");
  if (command.slice(newline + 1) !== stampScript) return undefined;
  const match = /^p='((?:[^']|'\\'')*)'$/.exec(command.slice(0, newline));
  if (!match) return undefined;
  const path = (match[1] ?? "").replaceAll(String.raw`'\''`, "'");
  const bytes = disk.files.get(path);
  const stdout = bytes ? `${disk.mtimes.get(path) ?? 0} ${bytes.length}` : "";
  return { exitCode: 0, stdout, stderr: "" };
}

/** Whether the fake runs this command itself: a test's own `rm -rf` goes to `onCommand`. */
const isBuiltIn = ([name, ...args]: string[]) =>
  builtIns.has(name ?? "") && (name !== "rm" || (args.length === 2 && args[0] === "-f"));

/** A command's words, with single-quoted words unquoted. */
const words = (command: string) =>
  [...command.matchAll(/'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");

/** The fake's archive: a JSON index of the members' paths and sizes, a newline, then their bytes. */
function packArchive(members: [string, Uint8Array][]): Uint8Array {
  const index = new TextEncoder().encode(
    `${JSON.stringify(members.map(([path, bytes]) => [path, bytes.length]))}\n`,
  );
  const archive = new Uint8Array(
    index.length + members.reduce((total, [, bytes]) => total + bytes.length, 0),
  );
  archive.set(index);
  let offset = index.length;
  for (const [, bytes] of members) {
    archive.set(bytes, offset);
    offset += bytes.length;
  }
  return archive;
}

/** An archive's members, or null when the bytes aren't one of the fake's archives. */
function unpackArchive(archive: Uint8Array): [string, Uint8Array][] | null {
  const newline = archive.indexOf(10);
  if (newline < 0) return null;
  let index: [string, number][];
  try {
    index = JSON.parse(new TextDecoder().decode(archive.subarray(0, newline)));
  } catch {
    return null;
  }
  let offset = newline + 1;
  return index.map(([path, size]) => {
    const bytes = archive.slice(offset, offset + size);
    offset += size;
    return [path, bytes];
  });
}
