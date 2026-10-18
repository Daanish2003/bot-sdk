/** What a command printed, and how it exited. A non-zero exit is a normal result. */
export type CommandResult = { exitCode: number; stdout: string; stderr: string };

/**
 * The seam between the `computer` plugin and what runs a user's Computer: a sandbox, named only
 * here. The plugin keeps each user's sandbox id and state in `chat.computer`; the provider only
 * acts on the sandbox it is given.
 */
export type ComputerProvider = {
  /** The template a new sandbox is built from, recorded on `chat.computer` as `template`. */
  template: string;
  /**
   * Creates a sandbox from `template`, running, and returns its id. It pauses itself once
   * `timeoutMs` passes (the backstop for a sleep that never runs).
   */
  create: (options: { timeoutMs: number }) => Promise<{ sandboxId: string }>;
  /** Resumes a paused sandbox, which then pauses itself once `timeoutMs` passes. */
  resume: (sandboxId: string, options: { timeoutMs: number }) => Promise<void>;
  /** Pauses a sandbox, snapshotting its memory and disk. Pausing a paused sandbox succeeds. */
  pause: (sandboxId: string) => Promise<void>;
  /** Moves the sandbox's self-pause to `timeoutMs` from now. */
  setTimeout: (sandboxId: string, timeoutMs: number) => Promise<void>;
  /**
   * Runs `command` with `bash -l -c` in `cwd` (the home directory, `/home/user`, when unset),
   * creating `cwd` first when it is missing, and waits for it to exit.
   */
  run: (sandboxId: string, command: string, options: { cwd?: string }) => Promise<CommandResult>;
};
