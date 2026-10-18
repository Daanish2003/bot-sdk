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
 * What the fake was asked to do, in order. A kill is of a running command, and a pause is recorded
 * only once it succeeded.
 */
export type FakeCall =
  | { [Type in Lifecycle]: { type: Type; sandboxId: string; timeoutMs: number } }[Lifecycle]
  | { type: "pause"; sandboxId: string }
  | { type: "timeout"; sandboxId: string; timeoutMs: number }
  | ({ type: "run" } & FakeCommand)
  | { type: "kill"; sandboxId: string; command: string };

/**
 * A Computer provider for tests: no sandbox, only a record of what it was asked to do. Each
 * command is answered by `onCommand`, which the test supplies (exit 0 with no output by default).
 * A command still running after its `timeoutMs` is killed and returns what it printed; one whose
 * `signal` aborts is killed and throws. Each lifecycle call in `failing` throws, recording nothing.
 * Each pause first awaits `onPause`, so a test can hold a pause, or make it fail by throwing. A
 * command or file operation on a paused sandbox throws, so an operation that skipped its wake fails.
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
  /** Throws for a paused sandbox, so an operation that skipped its wake fails. */
  const assertRunning = (sandboxId: string) => {
    if (paused.has(sandboxId)) throw new Error(`Sandbox ${sandboxId} is paused`);
  };
  /** The files of the fake Computer, by absolute path. */
  const files = new Map<string, Uint8Array>();
  let created = 0;
  const provider: ComputerProvider = {
    template,
    create: async ({ timeoutMs }) => {
      // A sandbox takes a moment to start, so operations that race a wake overlap it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      failIfTold("create");
      const sandboxId = `fake-sandbox-${++created}`;
      calls.push({ type: "create", sandboxId, timeoutMs });
      return { sandboxId };
    },
    resume: async (sandboxId, { timeoutMs }) => {
      failIfTold("resume");
      paused.delete(sandboxId);
      calls.push({ type: "resume", sandboxId, timeoutMs });
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
      assertRunning(sandboxId);
      calls.push({ type: "run", sandboxId, command, cwd, timeoutMs });
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
    readFile: async (sandboxId, path) => {
      assertRunning(sandboxId);
      return files.get(path) ?? null;
    },
    writeFile: async (sandboxId, path, content) => {
      assertRunning(sandboxId);
      files.set(path, new TextEncoder().encode(content));
    },
    list: async (sandboxId, path) => {
      assertRunning(sandboxId);
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
  return { provider, calls, callsOf, failing, files };
}
