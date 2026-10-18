import {
  CommandExitError,
  FileNotFoundError,
  FileType,
  NotFoundError,
  Sandbox,
  type CommandResult as E2bCommandResult,
} from "e2b";

import type { CommandResult, ComputerProvider, FileEntry, TimedOutCommand } from "../server";

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
  const open = (sandboxId: string) => Sandbox.connect(sandboxId, connection);

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
      await Sandbox.pause(sandboxId, connection);
    },

    async setTimeout(sandboxId, timeoutMs) {
      await Sandbox.setTimeout(sandboxId, timeoutMs, connection);
    },

    async run(sandboxId, command, { cwd = homeDirectory, timeoutMs, signal }) {
      signal?.throwIfAborted();
      const sandbox = await open(sandboxId);
      await sandbox.files.makeDir(cwd);
      let stdout = "";
      let stderr = "";
      // The SDK's own limit is off (0): the timer below kills the command and keeps its output.
      const handle = await sandbox.commands.run(command, {
        background: true,
        cwd,
        timeoutMs: 0,
        onStdout: (data) => void (stdout += data),
        onStderr: (data) => void (stderr += data),
      });
      const kill = () => handle.kill().catch(() => false);
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
            void kill().then(() => resolve({ timedOut: true, stdout, stderr }));
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
            resolve(resultOf(result, stdout, stderr));
          },
          (error: unknown) => {
            if (stopped) return;
            finish();
            // A non-zero exit is a result, not an error; anything else is the caller's to see.
            if (error instanceof CommandExitError) resolve(resultOf(error, stdout, stderr));
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

function resultOf(
  result: Pick<E2bCommandResult, "exitCode">,
  stdout: string,
  stderr: string,
): CommandResult {
  return { exitCode: result.exitCode, stdout, stderr };
}
