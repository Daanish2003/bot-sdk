import type {
  CommandResult,
  ComputerProvider,
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

/** What the fake was asked to do, in order. A kill is of a running command. */
export type FakeCall =
  | { [Type in Lifecycle]: { type: Type; sandboxId: string } }[Lifecycle]
  | ({ type: "run" } & FakeCommand)
  | { type: "kill"; sandboxId: string; command: string };

/**
 * A Computer provider for tests: no sandbox, only a record of what it was asked to do. Each
 * command is answered by `onCommand`, which the test supplies (exit 0 with no output by default).
 * A command still running after its `timeoutMs` is killed and returns what it printed; one whose
 * `signal` aborts is killed and throws. Each lifecycle call in `failing` throws, recording nothing.
 */
export function fakeComputerProvider({
  template = "fake-computer-v1",
  onCommand = () => ({ exitCode: 0, stdout: "", stderr: "" }),
}: {
  template?: string;
  onCommand?: (command: FakeCommandRun) => CommandResult | Promise<CommandResult>;
} = {}) {
  const calls: FakeCall[] = [];
  const failing = new Set<Lifecycle>();
  const failIfTold = (call: Lifecycle) => {
    if (failing.has(call)) throw new Error(`The fake was told to fail ${call}`);
  };
  let created = 0;
  const provider: ComputerProvider = {
    template,
    create: async () => {
      // A sandbox takes a moment to start, so operations that race a wake overlap it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      failIfTold("create");
      const sandboxId = `fake-sandbox-${++created}`;
      calls.push({ type: "create", sandboxId });
      return { sandboxId };
    },
    resume: async (sandboxId) => {
      failIfTold("resume");
      calls.push({ type: "resume", sandboxId });
    },
    run: (sandboxId, command, { cwd, timeoutMs, signal }) => {
      calls.push({ type: "run", sandboxId, command, cwd, timeoutMs });
      const killed = new AbortController();
      let stdout = "";
      return new Promise<CommandResult | TimedOutCommand>((resolve, reject) => {
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
  };
  /** The calls of one type. */
  const callsOf = <Type extends FakeCall["type"]>(type: Type) =>
    calls.filter((call): call is Extract<FakeCall, { type: Type }> => call.type === type);
  return { provider, calls, callsOf, failing };
}
