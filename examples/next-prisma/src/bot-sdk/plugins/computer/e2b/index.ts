import {
  CommandExitError,
  FileNotFoundError,
  FileType,
  NotFoundError,
  Sandbox,
  SandboxNotFoundError,
  type CommandResult as E2bCommandResult,
} from "e2b";

import type { CommandResult, ComputerProvider, FileEntry, TimedOutCommand } from "../server";
import { SandboxGoneError } from "../server/provider";
import { boundedOutput } from "./bounded-output";

/** The self-hosted E2B a Host points the adapter at, and the template it builds Computers from. */
export type E2bProviderOptions = {
  apiKey: string;
  apiUrl: string;
  sandboxUrl: string;
  /** The template's name, which is its version (for example `ai-chat-computer-v1`). */
  template: string;
};

const homeDirectory = "/home/user";

/** The longest delay a timer takes: a larger one fires after 1 ms. */
const maxTimerMs = 2 ** 31 - 1;

/**
 * The `computer` plugin's provider on self-hosted E2B (the open-source Firecracker runtime). It
 * is the only module that loads the `e2b` SDK, so a Host that never imports this subpath never
 * loads it.
 */
export function e2bProvider({
  apiKey,
  apiUrl,
  sandboxUrl,
  template,
}: E2bProviderOptions): ComputerProvider {
  const connection = { apiKey, apiUrl, sandboxUrl };
  // A connect to a running sandbox leaves its timeout alone unless the new one is longer.
  const open = (sandboxId: string) =>
    goneIfNotFound(sandboxId, () => Sandbox.connect(sandboxId, connection));

  return {
    template,

    async create({ timeoutMs }) {
      const sandbox = await Sandbox.create(template, {
        ...connection,
        timeoutMs,
        lifecycle: { onTimeout: "pause" },
      });
      return { sandboxId: sandbox.sandboxId };
    },

    async resume(sandboxId, { timeoutMs }) {
      try {
        await Sandbox.connect(sandboxId, { ...connection, timeoutMs });
        return "resumed";
      } catch (error) {
        if (error instanceof NotFoundError) return "gone";
        throw error;
      }
    },

    async kill(sandboxId) {
      await Sandbox.kill(sandboxId, connection);
    },

    async pause(sandboxId) {
      await goneIfNotFound(sandboxId, () => Sandbox.pause(sandboxId, connection));
    },

    async setTimeout(sandboxId, timeoutMs) {
      await goneIfNotFound(sandboxId, () => Sandbox.setTimeout(sandboxId, timeoutMs, connection));
    },

    async run(sandboxId, command, { cwd = homeDirectory, timeoutMs, signal }) {
      signal?.throwIfAborted();
      // Each stream keeps only its ends, so a command that prints without end can't exhaust memory.
      const out = boundedOutput();
      const err = boundedOutput();
      // The SDK's own limit is off (0): the timer below kills the command and keeps its output.
      const script = `mkdir -p ${quoted(cwd)} && cd ${quoted(cwd)} && exec setsid bash -c ${quoted(command)}`;
      const sandbox = await open(sandboxId);
      const handle = await sandbox.commands.run(script, {
        background: true,
        timeoutMs: 0,
        onStdout: (data) => out.add(data),
        onStderr: (data) => err.add(data),
      });
      const kill = async () => {
        await sandbox.commands.run(`kill -KILL -- -${handle.pid}`).catch(() => undefined);
        await handle.kill().catch(() => false);
      };
      return new Promise<CommandResult | TimedOutCommand>((resolve, reject) => {
        // Killing the command also settles `wait()`, which must not beat the outcome set here.
        let stopped = false;
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const timer = setTimeout(
          () => {
            stopped = true;
            finish();
            void kill().then(() =>
              resolve({ timedOut: true, stdout: out.text(), stderr: err.text() }),
            );
          },
          Math.min(timeoutMs, maxTimerMs),
        );
        const onAbort = () => {
          stopped = true;
          finish();
          void kill().then(() => reject(signal?.reason));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        // An abort during the setup above fired before this listener existed.
        if (signal?.aborted) onAbort();
        handle.wait().then(
          (result) => {
            if (stopped) return;
            finish();
            resolve(resultOf(result, out.text(), err.text()));
          },
          (error: unknown) => {
            if (stopped) return;
            finish();
            // A non-zero exit is a result, not an error; anything else is the caller's to see.
            if (error instanceof CommandExitError) resolve(resultOf(error, out.text(), err.text()));
            else reject(error);
          },
        );
      });
    },

    async readFile(sandboxId, path) {
      const sandbox = await open(sandboxId);
      try {
        return await sandbox.files.read(path, { format: "bytes" });
      } catch (error) {
        if (error instanceof FileNotFoundError) return null;
        throw error;
      }
    },

    async writeFile(sandboxId, path, content) {
      const sandbox = await open(sandboxId);
      const data =
        typeof content === "string"
          ? content
          : (content.buffer.slice(
              content.byteOffset,
              content.byteOffset + content.byteLength,
            ) as ArrayBuffer);
      await sandbox.files.write(path, data);
    },

    async list(sandboxId, path) {
      const sandbox = await open(sandboxId);
      try {
        const entries = await sandbox.files.list(path);
        return entries.map((entry): FileEntry => ({
          name: entry.name,
          kind: entry.type === FileType.DIR ? "directory" : "file",
          size: entry.size,
        }));
      } catch (error) {
        if (error instanceof FileNotFoundError) return null;
        throw error;
      }
    },
  };
}

/** A string as one shell word. */
function quoted(text: string) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Runs an E2B call on a sandbox, throwing `SandboxGoneError` when E2B no longer has it. */
async function goneIfNotFound<T>(sandboxId: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SandboxNotFoundError)
      throw new SandboxGoneError(sandboxId, { cause: error });
    throw error;
  }
}

function resultOf(
  result: Pick<E2bCommandResult, "exitCode">,
  stdout: string,
  stderr: string,
): CommandResult {
  return { exitCode: result.exitCode, stdout, stderr };
}
