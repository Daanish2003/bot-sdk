import { eq } from "drizzle-orm";

import { computer as computerTable } from "../../../core/server/db/schema";
import type { BotSdkContext, BotSdkPlugin } from "../../../core/server/plugin";
import type { CommandResult, ComputerProvider, FileEntry, TimedOutCommand } from "./provider";

/** How long a command may run when its caller doesn't say: 60 seconds. */
export const defaultCommandTimeoutMs = 60_000;

export type ComputerOptions = {
  /** What runs the Computers: E2B, or the tests' fake. */
  provider: ComputerProvider;
};

/**
 * One user's Computer. Every operation wakes it first when it isn't awake (a first create, or a
 * resume), and records activity when it starts and when it finishes. An operation whose wake
 * fails throws `ComputerUnavailableError`, and nothing runs.
 */
export type ComputerHandle = {
  /**
   * Runs `command` with `bash -l -c` in `cwd` (the home directory by default). A command still
   * running after `timeoutMs` (`defaultCommandTimeoutMs` when unset) or at `deadline`, whichever
   * comes first, is killed and returns what it printed so far; the wake's time counts toward
   * `deadline`. Once `signal` aborts, the command is killed and `run` throws its reason.
   */
  run: (
    command: string,
    options?: { cwd?: string; timeoutMs?: number; deadline?: Date; signal?: AbortSignal },
  ) => Promise<CommandResult | TimedOutCommand>;
  /** A file's bytes, or null when there is no such file. */
  readFile: (path: string) => Promise<Uint8Array | null>;
  /** Writes a file, creating any missing parent directories, and overwrites it. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** A directory's entries, one level deep, or null when there is no such directory. */
  list: (path: string) => Promise<FileEntry[] | null>;
};

/** An operation's wake failed: the provider couldn't create or resume the Computer. */
export class ComputerUnavailableError extends Error {
  constructor(userId: string, cause: unknown) {
    super(`The Computer of user ${userId} couldn't start`, { cause });
    this.name = "ComputerUnavailableError";
  }
}

/** The `computer` plugin's API (`sdk.plugin("computer")`). */
export type ComputerApi = {
  forUser: (userId: string) => ComputerHandle;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    computer: ComputerApi;
  }
}

export type ComputerPlugin = BotSdkPlugin<"computer", never, never>;

/**
 * The `computer` plugin (ADR 0020): one Computer per user, shared by all their Bots, on the
 * `provider`. It exposes operations, not tools: `bot` builds its tools from them.
 */
export function computer({ provider }: ComputerOptions): ComputerPlugin {
  return {
    id: "computer",
    requires: ["runner"],
    init: (sdk) => {
      const api: ComputerApi = {
        forUser: (userId) => {
          const operate = async <T>(act: (sandboxId: string) => Promise<T>) => {
            const sandboxId = await startOperation(sdk, provider, userId);
            try {
              return await act(sandboxId);
            } finally {
              await recordActivity(sdk, userId);
            }
          };
          return {
            run: (command, { cwd, timeoutMs = defaultCommandTimeoutMs, deadline, signal } = {}) =>
              operate((id) => {
                // A stop during the wake runs nothing.
                signal?.throwIfAborted();
                const left = deadline ? deadline.getTime() - sdk.clock().getTime() : timeoutMs;
                const limitMs = Math.max(0, Math.min(timeoutMs, left));
                return provider.run(id, command, { cwd, timeoutMs: limitMs, signal });
              }),
            readFile: (path) => operate((id) => provider.readFile(id, path)),
            writeFile: (path, content) => operate((id) => provider.writeFile(id, path, content)),
            list: (path) => operate((id) => provider.list(id, path)),
          };
        },
      };
      return { api };
    },
    // The row goes with its user, and its sandbox id is collected. Killing that sandbox after the
    // commit is the user delete ticket's (#525).
    deleteUser: {
      before: async (_sdk, { userId, tx }) => {
        const [deleted] = await tx
          .delete(computerTable)
          .where(eq(computerTable.userId, userId))
          .returning({ sandboxId: computerTable.sandboxId });
        return deleted?.sandboxId ?? null;
      },
      after: async () => {},
    },
  };
}

/**
 * An operation's start: records activity, creating the row on the user's first operation, and
 * returns the sandbox to act on, waking the Computer first when it isn't awake.
 */
async function startOperation(
  sdk: BotSdkContext,
  provider: ComputerProvider,
  userId: string,
): Promise<string> {
  const now = sdk.clock();
  const [row] = await sdk.db
    .insert(computerTable)
    .values({ userId, state: "asleep", lastActiveAt: now, createdAt: now })
    .onConflictDoUpdate({ target: computerTable.userId, set: { lastActiveAt: now } })
    .returning({ state: computerTable.state, sandboxId: computerTable.sandboxId });
  if (row?.state === "awake" && row.sandboxId) return row.sandboxId;
  return wake(sdk, provider, userId);
}

/**
 * Wakes the user's Computer under its row lock, which covers only this step: creates its sandbox
 * when it has none, else resumes it. Another operation that woke it meanwhile wins, and this one
 * uses its sandbox.
 */
async function wake(sdk: BotSdkContext, provider: ComputerProvider, userId: string) {
  return sdk.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(computerTable)
      .where(eq(computerTable.userId, userId))
      .for("update");
    if (!locked) throw new Error(`The Computer of user ${userId} has no row`);
    if (locked.state === "awake" && locked.sandboxId) return locked.sandboxId;
    const { sandboxId: asleepId } = locked;
    if (asleepId) {
      await unavailableOnFailure(sdk, userId, () => provider.resume(asleepId));
      await tx
        .update(computerTable)
        .set({ state: "awake" })
        .where(eq(computerTable.userId, userId));
      return asleepId;
    }
    const { sandboxId } = await unavailableOnFailure(sdk, userId, () => provider.create());
    await tx
      .update(computerTable)
      .set({ state: "awake", sandboxId, template: provider.template })
      .where(eq(computerTable.userId, userId));
    return sandboxId;
  });
}

/**
 * Runs the provider's create or resume. Its failure is the Computer's (it couldn't start), unlike
 * a failure of the database around it, which the caller retries.
 */
async function unavailableOnFailure<T>(
  sdk: BotSdkContext,
  userId: string,
  wakeUp: () => Promise<T>,
): Promise<T> {
  try {
    return await wakeUp();
  } catch (caught) {
    sdk.logger.error(`Waking the Computer of user ${userId} failed`, caught);
    throw new ComputerUnavailableError(userId, caught);
  }
}

/**
 * An operation's finish: records activity again, so a long command doesn't count as idle time.
 * A failure is logged, never thrown: the operation has already happened, and a throw would have
 * its caller run it again.
 */
async function recordActivity(sdk: BotSdkContext, userId: string) {
  try {
    await sdk.db
      .update(computerTable)
      .set({ lastActiveAt: sdk.clock() })
      .where(eq(computerTable.userId, userId));
  } catch (caught) {
    sdk.logger.error(`Recording the activity of the Computer of user ${userId} failed`, caught);
  }
}
