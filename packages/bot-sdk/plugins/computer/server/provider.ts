/** What a command printed, and how it exited. A non-zero exit is a normal result. */
export type CommandResult = { exitCode: number; stdout: string; stderr: string };

/** A command killed at its time limit: what it printed until then, and no exit code. */
export type TimedOutCommand = { timedOut: true; stdout: string; stderr: string };

/**
 * Where a port of a sandbox is reached from outside: the URL (scheme and host, and any path prefix,
 * without a trailing slash) and the headers every request to it must carry. Sandboxes are created
 * with public traffic off, so a request without them is refused (403).
 */
export type Endpoint = { url: string; headers: Record<string, string> };

/** One entry of a directory listing. */
export type FileEntry = { name: string; kind: "file" | "directory"; size: number };

/**
 * What a provider throws when the sandbox it is given no longer exists (its snapshot lost, or
 * killed): from a command, a file operation, a pause or a timeout. The plugin rebuilds it.
 */
export class SandboxGoneError extends Error {
  constructor(sandboxId: string, options?: { cause?: unknown }) {
    super(`Sandbox ${sandboxId} is gone`, options);
    this.name = "SandboxGoneError";
  }
}

/**
 * The seam between the `computer` plugin and what runs a user's Computer: a sandbox, named only
 * here. The plugin keeps each user's sandbox id and state in `chat.computer`; the provider only
 * acts on the sandbox it is given.
 */
export type ComputerProvider = {
  /** The template a new sandbox is built from, recorded on `chat.computer` as `template`. */
  template: string;
  /**
   * Creates a sandbox from `template`, running, with public traffic off, and returns its id. It pauses itself once
   * `timeoutMs` passes (the backstop for a sleep that never runs).
   */
  create: (options: { timeoutMs: number }) => Promise<{ sandboxId: string }>;
  /**
   * Where `port` of the sandbox is reached from outside: its URL, and the headers that carry the
   * sandbox's traffic access token and whatever routes the request to the sandbox and port.
   */
  endpoint: (sandboxId: string, port: number) => Promise<Endpoint>;
  /**
   * Resumes a paused sandbox, which then pauses itself once `timeoutMs` passes. A sandbox that no
   * longer exists (its snapshot lost, or killed) is `"gone"`, and the plugin rebuilds it.
   */
  resume: (sandboxId: string, options: { timeoutMs: number }) => Promise<"resumed" | "gone">;
  /** Kills a sandbox for good. Killing one that is already gone succeeds. */
  kill: (sandboxId: string) => Promise<void>;
  /** Pauses a sandbox, snapshotting its memory and disk. Pausing a paused sandbox succeeds. */
  pause: (sandboxId: string) => Promise<void>;
  /** Moves the sandbox's self-pause to `timeoutMs` from now. */
  setTimeout: (sandboxId: string, timeoutMs: number) => Promise<void>;
  /**
   * Runs `command` with `bash -l -c` in `cwd` (the home directory, `/home/user`, when unset),
   * creating `cwd` first when it is missing, and waits for it to exit. A command still running
   * after `timeoutMs` is killed and returns what it printed so far. Once `signal` aborts, the
   * command is killed and `run` throws its reason. `envs` are environment variables for this one
   * command only: nothing is set on the sandbox. `redact` are strings replaced with `***` in the
   * output as it arrives, before it is cut down to its ends.
   */
  run: (
    sandboxId: string,
    command: string,
    options: {
      cwd?: string;
      timeoutMs: number;
      signal?: AbortSignal;
      envs?: Record<string, string>;
      redact?: string[];
    },
  ) => Promise<CommandResult | TimedOutCommand>;
  /** A file's bytes, or null when there is no such file. */
  readFile: (sandboxId: string, path: string) => Promise<Uint8Array | null>;
  /** Writes `content` to `path`, creating any missing parent directories and overwriting. */
  writeFile: (sandboxId: string, path: string, content: string | Uint8Array) => Promise<void>;
  /** The entries of a directory, one level deep, or null when there is no such directory. */
  list: (sandboxId: string, path: string) => Promise<FileEntry[] | null>;
};
