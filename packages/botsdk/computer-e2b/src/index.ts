import {
  CommandExitError,
  ConnectionConfig,
  FileNotFoundError,
  FileType,
  NotFoundError,
  Sandbox,
  SandboxNotFoundError,
  SandboxNotRunningError,
  type CommandResult as E2bCommandResult,
} from "e2b";

import type {
  CommandResult,
  ComputerProvider,
  FileEntry,
  TimedOutCommand,
} from "@botsdk/bot/computer";
import { boundedOutput, redactedOutput, SandboxGoneError } from "@botsdk/bot/computer/internal";

/** The self-hosted E2B a Host points the adapter at, and the template it builds Computers from. */
export type E2bProviderOptions = {
  apiKey: string;
  apiUrl: string;
  /**
   * Where the self-hosted E2B serves sandbox ports (`E2B_SANDBOX_URL`), routing each request by its
   * `E2b-Sandbox-Id` and `E2b-Sandbox-Port` headers. Unset, the SDK reads `E2B_SANDBOX_URL`; with
   * neither, a port is reached at its own host (`https://<port>-<id>.<domain>`).
   */
  sandboxUrl?: string;
  /** The template's name, which is its version (for example `ai-chat-computer-v1`). */
  template: string;
};

const homeDirectory = "/home/user";

/** The longest delay a timer takes: a larger one fires after 1 ms. */
const maxTimerMs = 2 ** 31 - 1;

/**
 * The computer slot's provider on self-hosted E2B (the open-source Firecracker runtime). It
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
  // Resolved as the SDK resolves it for envd (the option, else `E2B_SANDBOX_URL`), so a port's
  // traffic, and its traffic token, go where the sandbox's own traffic goes.
  const resolved = new ConnectionConfig(connection);
  const portsUrl = resolved.sandboxUrl?.replace(/\/+$/, "");
  // The connected sandbox of each id: a connect is a control-plane round trip, and an operation
  // would pay it every time. An entry goes when its sandbox is paused, killed or gone, and when
  // a call on it fails, so the next call connects afresh.
  const connected = new Map<string, Promise<Sandbox>>();
  const forget = (sandboxId: string) => {
    connected.delete(sandboxId);
  };
  // A connect to a running sandbox leaves its timeout alone unless the new one is longer.
  const open = (sandboxId: string) => {
    let sandbox = connected.get(sandboxId);
    if (!sandbox) {
      sandbox = Sandbox.connect(sandboxId, connection);
      connected.set(sandboxId, sandbox);
      const attempt = sandbox;
      sandbox.catch(() => {
        if (connected.get(sandboxId) === attempt) forget(sandboxId);
      });
    }
    return sandbox;
  };
  /** Runs a call on the sandbox, throwing `SandboxGoneError` when E2B no longer has it. */
  const withSandbox = async <T>(
    sandboxId: string,
    call: (sandbox: Sandbox) => Promise<T>,
    retried = false,
  ): Promise<T> => {
    try {
      return await call(await open(sandboxId));
    } catch (error) {
      forget(sandboxId);
      const stale =
        error instanceof SandboxNotRunningError || error instanceof SandboxNotFoundError;
      // A cached connection can be stale: the sandbox was paused or killed behind its back. One
      // fresh connect resumes it or finds it gone. No call had run yet, so it is safe to make it again.
      if (stale && !retried) return withSandbox(sandboxId, call, true);
      if (error instanceof SandboxNotFoundError)
        throw new SandboxGoneError(sandboxId, { cause: error });
      throw error;
    }
  };

  return {
    template,

    async create({ timeoutMs }) {
      const sandbox = await Sandbox.create(template, {
        ...connection,
        timeoutMs,
        lifecycle: { onTimeout: "pause" },
        // A port is reached only with the sandbox's traffic access token: the Screens' noVNC and
        // DevTools ports must not be open to anyone who finds the URL.
        network: { allowPublicTraffic: false },
      });
      connected.set(sandbox.sandboxId, Promise.resolve(sandbox));
      return { sandboxId: sandbox.sandboxId };
    },

    async endpoint(sandboxId, port) {
      const { token, host } = await withSandbox(sandboxId, async (sandbox) => ({
        token: sandbox.trafficAccessToken,
        host: portsUrl ? undefined : sandbox.getHost(port),
      }));
      const headers: Record<string, string> = token ? { "e2b-traffic-access-token": token } : {};
      // The Embed serves every port at its sandbox URL and routes by these headers, as the SDK
      // does for envd; a port's own host (`*.e2b.app`) is E2B Cloud's.
      if (portsUrl) {
        return {
          url: portsUrl,
          headers: { ...headers, "E2b-Sandbox-Id": sandboxId, "E2b-Sandbox-Port": String(port) },
        };
      }
      // In debug mode the SDK's host is a plain-HTTP localhost port.
      return { url: `${resolved.debug ? "http" : "https"}://${host}`, headers };
    },

    async resume(sandboxId, { timeoutMs }) {
      forget(sandboxId);
      try {
        const sandbox = await Sandbox.connect(sandboxId, { ...connection, timeoutMs });
        connected.set(sandboxId, Promise.resolve(sandbox));
        return "resumed";
      } catch (error) {
        if (error instanceof NotFoundError) return "gone";
        throw error;
      }
    },

    async kill(sandboxId) {
      forget(sandboxId);
      await Sandbox.kill(sandboxId, connection);
    },

    async pause(sandboxId) {
      forget(sandboxId);
      await goneIfNotFound(sandboxId, () => Sandbox.pause(sandboxId, connection));
    },

    async setTimeout(sandboxId, timeoutMs) {
      await goneIfNotFound(sandboxId, () => Sandbox.setTimeout(sandboxId, timeoutMs, connection));
    },

    async run(sandboxId, command, { cwd = homeDirectory, timeoutMs, signal, envs, redact }) {
      signal?.throwIfAborted();
      // Each stream keeps only its ends, so a command that prints without end can't exhaust memory.
      const out = redact ? redactedOutput(redact) : boundedOutput();
      const err = redact ? redactedOutput(redact) : boundedOutput();
      // The command gets a process group of its own, and creates its directory in the same call,
      // so a kill can reach the children and background jobs the command started, which a kill
      // of the shell alone leaves running. `exec` makes the tracked pid the group's id, unless
      // setsid forks (it does when its caller leads a group): then the group is its child's, and
      // `-w` makes the tracked pid wait for that child. `bash -l` loads the profile, as the
      // handle promises.
      const script = `mkdir -p ${quoted(cwd)} && cd ${quoted(cwd)} && exec setsid -w bash -l -c ${quoted(command)}`;
      const { sandbox, handle } = await withSandbox(sandboxId, async (sandbox) => ({
        sandbox,
        // The SDK's own limit is off (0): the timer below kills the command and keeps its output.
        handle: await sandbox.commands.run(script, {
          background: true,
          timeoutMs: 0,
          ...(envs && { envs }),
          onStdout: (data) => out.add(data),
          onStderr: (data) => err.add(data),
        }),
      }));
      // The group kill reaches both cases: the tracked pid's group, and the groups its children
      // lead (a forked setsid's). It goes first, since the children are found through the pid.
      const pid = handle.pid;
      const killGroups = `c=$(cat /proc/${pid}/task/${pid}/children 2>/dev/null); kill -KILL -- -${pid} $(for g in $c; do printf ' -%s' "$g"; done)`;
      const kill = async () => {
        await sandbox.commands.run(killGroups).catch(() => undefined);
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
      return withSandbox(sandboxId, async (sandbox) => {
        try {
          return await sandbox.files.read(path, { format: "bytes" });
        } catch (error) {
          if (error instanceof FileNotFoundError) return null;
          throw error;
        }
      });
    },

    async writeFile(sandboxId, path, content) {
      const data =
        typeof content === "string"
          ? content
          : (content.buffer.slice(
              content.byteOffset,
              content.byteOffset + content.byteLength,
            ) as ArrayBuffer);
      await withSandbox(sandboxId, (sandbox) => sandbox.files.write(path, data));
    },

    async list(sandboxId, path) {
      return withSandbox(sandboxId, async (sandbox) => {
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
      });
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
