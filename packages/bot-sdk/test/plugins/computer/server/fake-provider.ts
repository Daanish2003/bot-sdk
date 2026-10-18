import { posix } from "node:path";

import type {
  CommandResult,
  ComputerProvider,
  FileEntry,
  TimedOutCommand,
} from "../../../../plugins/computer/server/provider";

/** One command the fake ran: where, on which sandbox, and with what time limit. */
export type FakeCommand = {
  sandboxId: string;
  command: string;
  cwd: string | undefined;
  timeoutMs: number;
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
  | { type: "pause"; sandboxId: string }
  | { type: "timeout"; sandboxId: string; timeoutMs: number }
  | ({ type: "run" } & FakeCommand)
  | { type: "kill"; sandboxId: string; command: string }
  | { type: "kill-sandbox"; sandboxId: string };

/** One sandbox's disk: each file's bytes, and the write that last changed it as its mtime. */
type Disk = { files: Map<string, Uint8Array>; mtimes: Map<string, number> };

const newDisk = (): Disk => ({ files: new Map(), mtimes: new Map() });

/**
 * A Computer provider for tests: no sandbox, only a record of what it was asked to do, and a disk
 * per sandbox. Each command is answered by `onCommand`, which the test supplies (exit 0 with no
 * output by default), except the commands the sync and restore use (`mkdir -p`, `find … -prune`, `rm -f`,
 * `tar -czf`, `tar -xzf`, `stat -c %s`, joined by `&&`), which the fake runs on the disk. Its
 * archives are uncompressed, so a file's size is its archive's.
 *
 * A command still running after its `timeoutMs` is killed and returns what it printed; one whose
 * `signal` aborts is killed and throws. Each lifecycle call in `failing` throws, recording nothing.
 * Each pause first awaits `onPause`, so a test can hold a pause, or make it fail by throwing. A
 * command or file operation on a paused sandbox throws, so an operation that skipped its wake
 * fails. `lose(sandboxId)` makes a sandbox gone: its disk is dropped and a resume reports it gone.
 */
export function fakeComputerProvider({
  template = "fake-computer-v1",
  onCommand = () => ({ exitCode: 0, stdout: "", stderr: "" }),
  onPause = () => {},
}: {
  template?: string;
  onCommand?: (command: FakeCommandRun) => CommandResult | Promise<CommandResult>;
  onPause?: (sandboxId: string) => void | Promise<void>;
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
    if (!disk) throw new Error(`Sandbox ${sandboxId} is gone`);
    return disk;
  };
  let created = 0;
  let writes = 0;
  const write = (disk: Disk, path: string, bytes: Uint8Array) => {
    disk.files.set(path, bytes);
    disk.mtimes.set(path, ++writes);
  };
  const provider: ComputerProvider = {
    template,
    create: async ({ timeoutMs }) => {
      // A sandbox takes a moment to start, so operations that race a wake overlap it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      failIfTold("create");
      const sandboxId = `fake-sandbox-${++created}`;
      // A sandbox built from the template starts with nothing of an earlier one's.
      if (created > 1) current = newDisk();
      disks.set(sandboxId, current);
      calls.push({ type: "create", sandboxId, timeoutMs });
      return { sandboxId };
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
      // Pausing a paused sandbox succeeds, as the provider seam promises.
      paused.add(sandboxId);
      calls.push({ type: "pause", sandboxId });
    },
    setTimeout: async (sandboxId, timeoutMs) => {
      calls.push({ type: "timeout", sandboxId, timeoutMs });
    },
    run: async (sandboxId, command, { cwd, timeoutMs, signal }) => {
      const disk = runningDisk(sandboxId);
      calls.push({ type: "run", sandboxId, command, cwd, timeoutMs });
      const builtIn = runBuiltIn(disk, command, cwd ?? "/home/user", write);
      if (builtIn) return builtIn;
      const killed = new AbortController();
      let stdout = "";
      return await new Promise<CommandResult | TimedOutCommand>((resolve, reject) => {
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
            onCommand({ sandboxId, command, cwd, timeoutMs, signal: killed.signal, print }),
          )
          .then(
            (result) => settle(false, () => resolve(result)),
            (caught) => settle(false, () => reject(caught)),
          );
      });
    },
    readFile: async (sandboxId, path) => runningDisk(sandboxId).files.get(path) ?? null,
    writeFile: async (sandboxId, path, content) => {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      write(runningDisk(sandboxId), path, bytes);
    },
    list: async (sandboxId, path) => {
      const { files } = runningDisk(sandboxId);
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

const builtIns = new Set(["mkdir", "find", "rm", "stat", "tar"]);

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
