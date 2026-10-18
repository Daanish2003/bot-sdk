/** What a command printed, and how it exited. A non-zero exit is a normal result. */
export type CommandResult = { exitCode: number; stdout: string; stderr: string };

/** A command killed at its time limit: what it printed until then, and no exit code. */
export type TimedOutCommand = { timedOut: true; stdout: string; stderr: string };

/**
 * The seam between the `computer` plugin and what runs a user's Computer: a sandbox, named only
 * here. The plugin keeps each user's sandbox id and state in `chat.computer`; the provider only
 * acts on the sandbox it is given.
 */
export type ComputerProvider = {
  /** The template a new sandbox is built from, recorded on `chat.computer` as `template`. */
  template: string;
  /** Creates a sandbox from `template`, running, and returns its id. */
  create: () => Promise<{ sandboxId: string }>;
  /** Resumes a paused sandbox. */
  resume: (sandboxId: string) => Promise<void>;
  /**
   * Runs `command` with `bash -l -c` in `cwd` (the home directory, `/home/user`, when unset),
   * creating `cwd` first when it is missing, and waits for it to exit. A command still running
   * after `timeoutMs` is killed and returns what it printed so far. Once `signal` aborts, the
   * command is killed and `run` throws its reason.
   */
  run: (
    sandboxId: string,
    command: string,
    options: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
  ) => Promise<CommandResult | TimedOutCommand>;
};
