import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { deleteBlobsBestEffort } from "../../../core/server/blob/store";
import { computer as computerTable } from "../../../core/server/db/schema";
import type { BotSdkContext, BotSdkPlugin, Transaction } from "../../../core/server/plugin";
import { defineJob } from "../../runner/server/jobs/define";
import { isInProcessRunner } from "../../runner/server/jobs/in-process";
import { cancelQueuedJobsIn } from "../../runner/server/jobs/store";
import { runnerJobs } from "../../runner/server/plugin";
import {
  type CommandResult,
  type ComputerProvider,
  type FileEntry,
  SandboxGoneError,
  type TimedOutCommand,
} from "./provider";

/** How long a command may run when its caller doesn't say: 60 seconds. */
export const defaultCommandTimeoutMs = 60_000;

/** A Computer whose last activity is older than this is idle, so its sleep check may pause it. */
export const computerIdleMs = 5 * 60_000;

/** The soonest a check that kept the Computer awake checks again. */
const followUpAtLeastMs = 60_000;

/**
 * The provider's own timeout, after which the sandbox pauses itself: set by each create and resume,
 * and extended by each check that keeps the Computer awake, so a dead server still lets it sleep.
 */
const backstopTimeoutMs = 60 * 60_000;

/** The home directory, where the synced trees live and an archive is restored. */
const computerHome = "/home/user";

/**
 * What a sleep syncs: the Bots' directories and the shared one, minus every `.outputs/` (spilled
 * outputs that can be produced again). Nothing else survives a rebuild.
 */
const syncedTrees = "bots shared";

/** The largest archive stored, compressed: 100 MB. A bigger one is skipped, and the last one stays. */
export const syncCapBytes = 100 * 1024 * 1024;

/** How long each command of a sync or a restore may run. */
const syncCommandTimeoutMs = 2 * 60_000;

/** Where a sync writes the archive in the sandbox, and where a restore writes it before extracting. */
const archivePath = "/tmp/computer-sync.tar.gz";
const restorePath = "/tmp/computer-restore.tar.gz";

/**
 * Lists the synced files (path, size and mtime in whole seconds, as tar keeps it), the input of the
 * sync's fingerprint. Directories are left out, so a new `.outputs/` changes nothing.
 */
const listCommand = `mkdir -p ${syncedTrees} && find ${syncedTrees} -name .outputs -prune -o ! -type d -printf '%p %s %Ts\\n'`;

/**
 * Archives the synced trees and prints the archive's size. tar's exit 1 ("file changed as we read
 * it") still wrote the archive, so only a worse exit fails.
 */
const archiveCommand = `tar -czf ${archivePath} --exclude=.outputs ${syncedTrees} || [ $? -eq 1 ] && stat -c %s ${archivePath}`;

/** The blob key of a user's Computer archive. */
export const computerBlobKey = (userId: string) => `computer/${userId}`;

/** The self-chaining sleep check's job name. */
const sleepJobName = "computer.sleep";

export type ComputerOptions = {
  /** What runs the Computers: E2B, or the tests' fake. */
  provider: ComputerProvider;
};

/**
 * Whether something still uses the user's Computer, whose last activity was at `lastActiveAt`.
 * The sleep check pauses an idle Computer only when every busy check returns false.
 */
export type BusyCheck = (userId: string, lastActiveAt: Date) => Promise<boolean>;

/**
 * A rebuild a wake did: the Computer was built again from its template and its synced files were
 * restored, as of `restoredAsOf` (null when there was no archive, so it started empty).
 */
export type Rebuild = { restoredAsOf: Date | null };

/**
 * One user's Computer. Every operation wakes it first when it isn't awake (a first create, a
 * resume, or a rebuild), and records activity when it starts and when it finishes. An operation
 * whose wake fails throws `ComputerUnavailableError`, and nothing runs. One the provider fails
 * (a permission denied, a read of a directory) throws `ComputerOperationError`; one whose sandbox
 * turns out gone rebuilds it and runs once more. A stop rethrows its reason as it is.
 */
export type ComputerHandle = {
  /**
   * The rebuild that a wake of this handle's operations did, once: the first call after it
   * returns it, and later calls null until another rebuild. It lives in memory only.
   */
  takeRebuild: () => Rebuild | null;
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

/**
 * An operation's wake failed: the provider couldn't create, resume or rebuild the Computer, or a
 * rebuild couldn't restore its files.
 */
export class ComputerUnavailableError extends Error {
  constructor(userId: string, cause: unknown) {
    super(`The Computer of user ${userId} couldn't start`, { cause });
    this.name = "ComputerUnavailableError";
  }
}

/**
 * An operation the provider failed after the Computer woke: its `message` is the cause's, for
 * the caller (a Bot) to act on. A database failure is never one: it throws as it is.
 */
export class ComputerOperationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ComputerOperationError";
  }
}

/** The `computer` plugin's API (`sdk.plugin("computer")`). */
export type ComputerApi = {
  forUser: (userId: string) => ComputerHandle;
  /**
   * Adds a check that keeps an idle Computer awake while it returns true, so `computer` learns
   * "in use" from the plugins that use it without knowing about them.
   */
  addBusyCheck: (check: BusyCheck) => void;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    computer: ComputerApi;
  }
}

export type ComputerPlugin = BotSdkPlugin<"computer", never, never>;

// Each instance's sleep check, keyed by its `computer` API, which `plugin("computer")` returns.
const sleepChecks = new WeakMap<object, (userId: string) => Promise<void>>();

/**
 * The sleep check (#508): puts the user's Computer to sleep once it is idle and nothing holds it,
 * else checks again later. Each wake arms one, so there is one chain per awake period. A check
 * that keeps failing (a pause that fails) is armed again in 5 minutes.
 */
export const computerSleepJob = defineJob({
  name: sleepJobName,
  payload: z.object({ userId: z.string() }),
  run: async ({ userId }, { deps }) => {
    // A check queued before the Host turned computer off ends its chain.
    if (!deps.hasPlugin("computer")) return;
    const check = sleepChecks.get(deps.plugin("computer"));
    if (!check) throw new Error("The computer plugin wasn't initialised");
    await check(userId);
  },
  onFailed: async ({ userId }, error, deps) => {
    deps.logger.error(`The sleep check of the Computer of user ${userId} failed`, error);
    await armSleepCheck(deps, userId, after(deps.clock(), computerIdleMs));
  },
});

/**
 * The `computer` plugin (ADR 0020): one Computer per user, shared by all their Bots, on the
 * `provider`. It exposes operations, not tools: `bot` builds its tools from them.
 */
export function computer({ provider }: ComputerOptions): ComputerPlugin {
  return {
    id: "computer",
    requires: ["runner"],
    init: (sdk) => {
      // A wake queues its sleep check in its own transaction, which only the in-process runner reads.
      if (!isInProcessRunner(runnerJobs(sdk))) {
        throw new Error(
          "The computer plugin needs the in-process runner: a wake queues its sleep check in its transaction",
        );
      }
      const busyChecks: BusyCheck[] = [];
      const api: ComputerApi = {
        forUser: (userId) => {
          let lastRebuild: Rebuild | null = null;
          const operate = async <T>(
            act: (sandboxId: string) => Promise<T>,
            signal?: AbortSignal,
          ) => {
            let woken = await startOperation(sdk, provider, userId);
            try {
              for (let retried = false; ; retried = true) {
                if (woken.rebuild) lastRebuild = woken.rebuild;
                try {
                  return await act(woken.sandboxId);
                } catch (caught) {
                  if (signal?.aborted) throw caught;
                  // The row said awake, but the sandbox is gone: the wake rebuilds it, once.
                  if (caught instanceof SandboxGoneError && !retried) {
                    await markAsleep(sdk, userId, woken.sandboxId);
                    woken = await wake(sdk, provider, userId);
                    continue;
                  }
                  throw new ComputerOperationError(caught);
                }
              }
            } finally {
              await recordActivity(sdk, userId);
            }
          };
          return {
            takeRebuild: () => {
              const taken = lastRebuild;
              lastRebuild = null;
              return taken;
            },
            run: (command, { cwd, timeoutMs = defaultCommandTimeoutMs, deadline, signal } = {}) =>
              operate((id) => {
                // A stop during the wake runs nothing.
                signal?.throwIfAborted();
                const left = deadline ? deadline.getTime() - sdk.clock().getTime() : timeoutMs;
                const limitMs = Math.max(0, Math.min(timeoutMs, left));
                return provider.run(id, command, { cwd, timeoutMs: limitMs, signal });
              }, signal),
            readFile: (path) => operate((id) => provider.readFile(id, path)),
            writeFile: (path, content) => operate((id) => provider.writeFile(id, path, content)),
            list: (path) => operate((id) => provider.list(id, path)),
          };
        },
        addBusyCheck: (check) => {
          busyChecks.push(check);
        },
      };
      sleepChecks.set(api, (userId) => sleepCheck(sdk, provider, busyChecks, userId));
      return { api };
    },
    // The row goes with its user, with its queued sleep checks, and its sandbox id is collected.
    // After the commit the sandbox is killed and the archive deleted, both best-effort. A check
    // that runs anyway finds no row and ends. Deleting a Bot never reaches here: its files stay.
    deleteUser: {
      before: async (sdk, { userId, tx }) => {
        await cancelQueuedJobsIn(tx, sleepJobName, { field: "userId", value: userId }, sdk.clock());
        const [deleted] = await tx
          .delete(computerTable)
          .where(eq(computerTable.userId, userId))
          .returning({ sandboxId: computerTable.sandboxId });
        return deleted?.sandboxId ?? null;
      },
      after: async (sdk, { userId, collected }) => {
        if (typeof collected === "string") await killBestEffort(sdk, provider, userId, collected);
        await deleteBlobsBestEffort(sdk, [computerBlobKey(userId)]);
      },
    },
  };
}

/**
 * An operation's start: records activity, creating the row on the user's first operation, and
 * returns the sandbox to act on, waking the Computer first when it isn't awake. While a sleep
 * check holds the row lock, the update waits for it, then sees `asleep` and wakes the Computer.
 */
async function startOperation(
  sdk: BotSdkContext,
  provider: ComputerProvider,
  userId: string,
): Promise<Woken> {
  const now = sdk.clock();
  const [row] = await sdk.db
    .insert(computerTable)
    .values({ userId, state: "asleep", lastActiveAt: now, createdAt: now })
    .onConflictDoUpdate({ target: computerTable.userId, set: { lastActiveAt: now } })
    .returning({ state: computerTable.state, sandboxId: computerTable.sandboxId });
  if (row?.state === "awake" && row.sandboxId) return { sandboxId: row.sandboxId, rebuild: null };
  return wake(sdk, provider, userId);
}

/** The sandbox an operation acts on, and the rebuild its wake did, if any. */
type Woken = { sandboxId: string; rebuild: Rebuild | null };

/**
 * Wakes the user's Computer under its row lock, which covers only this step: creates its sandbox
 * when it has none, rebuilds it when its template changed or the provider reports it gone, and
 * else resumes it. Another operation that woke it meanwhile wins, and this one uses its sandbox.
 * A wake arms one sleep check in its transaction, so the check exists exactly when the Computer
 * became awake. A failed wake throws, so the row keeps its old sandbox and the next call retries;
 * a sandbox it created before the failure is killed, since the row never names it.
 */
async function wake(sdk: BotSdkContext, provider: ComputerProvider, userId: string) {
  let created: string | undefined;
  const { woken, replaced } = await sdk.db
    .transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(computerTable)
        .where(eq(computerTable.userId, userId))
        .for("update");
      if (!locked) throw new Error(`The Computer of user ${userId} has no row`);
      if (locked.state === "awake" && locked.sandboxId) {
        return { woken: { sandboxId: locked.sandboxId, rebuild: null }, replaced: null };
      }
      let woken: Woken;
      const asleepId = locked.sandboxId;
      const stale = locked.template !== provider.template;
      if (!asleepId) {
        // A first create: nothing to restore, and nothing to tell.
        const { sandboxId } = await unavailableOnFailure(sdk, userId, () =>
          provider.create({ timeoutMs: backstopTimeoutMs }),
        );
        woken = { sandboxId, rebuild: null };
      } else if (
        !stale &&
        (await unavailableOnFailure(sdk, userId, () =>
          provider.resume(asleepId, { timeoutMs: backstopTimeoutMs }),
        )) === "resumed"
      ) {
        woken = { sandboxId: asleepId, rebuild: null };
      } else {
        woken = await rebuild(sdk, provider, locked);
      }
      if (woken.sandboxId !== asleepId) created = woken.sandboxId;
      await tx
        .update(computerTable)
        .set({ state: "awake", sandboxId: woken.sandboxId, template: provider.template })
        .where(eq(computerTable.userId, userId));
      await armSleepCheck(sdk, userId, after(sdk.clock(), computerIdleMs), tx);
      return { woken, replaced: asleepId && asleepId !== woken.sandboxId ? asleepId : null };
    })
    .catch(async (caught: unknown) => {
      if (created) await killBestEffort(sdk, provider, userId, created);
      throw caught;
    });
  // A rebuild's old sandbox goes once the row names the new one; a gone one is killed harmlessly.
  if (replaced) await killBestEffort(sdk, provider, userId, replaced);
  return woken;
}

/** Marks the Computer asleep while its row still names `sandboxId`, gone, so the next wake rebuilds it. */
async function markAsleep(sdk: BotSdkContext, userId: string, sandboxId: string) {
  await sdk.db
    .update(computerTable)
    .set({ state: "asleep" })
    .where(and(eq(computerTable.userId, userId), eq(computerTable.sandboxId, sandboxId)));
}

/** Kills a sandbox the row no longer names. A failure is logged with the sandbox id, never thrown. */
async function killBestEffort(
  sdk: BotSdkContext,
  provider: ComputerProvider,
  userId: string,
  sandboxId: string,
) {
  try {
    await provider.kill(sandboxId);
  } catch (caught) {
    sdk.logger.error(
      `Killing sandbox ${sandboxId} of the Computer of user ${userId} failed`,
      caught,
    );
  }
}

/**
 * Builds the Computer again from the template and restores its last archive into the home
 * directory; with no archive, it starts empty. A failed restore kills the new sandbox and throws
 * `ComputerUnavailableError`, so the wake fails instead of handing back a Computer without files.
 */
async function rebuild(
  sdk: BotSdkContext,
  provider: ComputerProvider,
  row: typeof computerTable.$inferSelect,
): Promise<Woken> {
  const { userId } = row;
  const { sandboxId } = await unavailableOnFailure(sdk, userId, () =>
    provider.create({ timeoutMs: backstopTimeoutMs }),
  );
  try {
    const archive = row.syncedAt ? await sdk.blobStore.get(computerBlobKey(userId)) : null;
    if (row.syncedAt && !archive) {
      sdk.logger.error(`The archive of the Computer of user ${userId} is missing; it starts empty`);
    }
    if (archive) {
      await provider.writeFile(sandboxId, restorePath, archive);
      await syncCommand(
        provider,
        sandboxId,
        `tar -xzf ${restorePath} -C ${computerHome} && rm -f ${restorePath}`,
        "Extracting the archive",
      );
    }
    return { sandboxId, rebuild: { restoredAsOf: archive ? row.syncedAt : null } };
  } catch (caught) {
    await killBestEffort(sdk, provider, userId, sandboxId);
    sdk.logger.error(`Restoring the files of the Computer of user ${userId} failed`, caught);
    throw new ComputerUnavailableError(userId, caught);
  }
}

/**
 * Stores the Computer's files in the blob store as one archive, unless their listing matches the
 * last archive's fingerprint, and returns the `synced_*` columns to record. Any failure (an
 * archive over the cap, `tar`, the provider, the blob store) is logged with its cause and returns
 * null, so the columns stay and the pause goes ahead.
 */
async function syncFiles(
  sdk: BotSdkContext,
  provider: ComputerProvider,
  sandboxId: string,
  { userId, syncFingerprint }: typeof computerTable.$inferSelect,
) {
  try {
    const listing = await syncCommand(provider, sandboxId, listCommand, "Listing the files");
    const fingerprint = createHash("sha256")
      .update(listing.split("\n").filter(Boolean).sort().join("\n"))
      .digest("hex");
    if (fingerprint === syncFingerprint) return null;
    const bytes = await readArchive(sdk, provider, sandboxId, userId);
    if (!bytes) return null;
    await sdk.blobStore.put(computerBlobKey(userId), bytes, { contentType: "application/gzip" });
    return { syncedAt: sdk.clock(), syncFingerprint: fingerprint, syncedBytes: bytes.length };
  } catch (caught) {
    sdk.logger.error(`Syncing the files of the Computer of user ${userId} failed`, caught);
    return null;
  }
}

/**
 * Archives the synced trees and reads the archive's bytes, or returns null for one over the cap,
 * logged with its size. The archive is removed from the sandbox either way, so no snapshot keeps it.
 */
async function readArchive(
  sdk: BotSdkContext,
  provider: ComputerProvider,
  sandboxId: string,
  userId: string,
) {
  try {
    const size = Number(
      (await syncCommand(provider, sandboxId, archiveCommand, "Archiving the files")).trim(),
    );
    if (size > syncCapBytes) {
      sdk.logger.error(
        `The archive of the Computer of user ${userId} is ${size} bytes, over the ${syncCapBytes}-byte cap; the last archive stays`,
      );
      return null;
    }
    const bytes = await provider.readFile(sandboxId, archivePath);
    if (!bytes) throw new Error(`${archivePath} is missing`);
    return bytes;
  } finally {
    await syncCommand(provider, sandboxId, `rm -f ${archivePath}`, "Removing the archive").catch(
      () => {},
    );
  }
}

/** Runs one of the sync's or the restore's commands in the home directory, and returns its stdout. */
async function syncCommand(
  provider: ComputerProvider,
  sandboxId: string,
  command: string,
  what: string,
): Promise<string> {
  const result = await provider.run(sandboxId, command, {
    cwd: computerHome,
    timeoutMs: syncCommandTimeoutMs,
  });
  if ("timedOut" in result) throw new Error(`${what} timed out`);
  if (result.exitCode !== 0) {
    throw new Error(`${what} exited ${result.exitCode}: ${result.stderr.slice(0, 1_000)}`);
  }
  return result.stdout;
}

/**
 * One sleep check, under the row lock until it commits, so an operation that arrives meanwhile
 * waits and then wakes the Computer. An asleep Computer's chain ends. An idle one that no busy
 * check holds has its files synced, then is paused and marked `asleep`, with the sync recorded; a
 * failed pause throws before the row changes, so the runner retries. Otherwise the provider's
 * timeout is extended and one follow-up is armed, in the same transaction, so the chain can't end
 * while the Computer stays awake. A sandbox found gone is marked `asleep` and its chain ends, so
 * the next wake rebuilds it.
 */
async function sleepCheck(
  sdk: BotSdkContext,
  provider: ComputerProvider,
  busyChecks: readonly BusyCheck[],
  userId: string,
): Promise<void> {
  await sdk.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(computerTable)
      .where(eq(computerTable.userId, userId))
      .for("update");
    // A deleted user's row is gone, and an asleep Computer's chain ends with its awake period.
    if (!locked?.sandboxId || locked.state === "asleep") return;
    const { sandboxId } = locked;
    const now = sdk.clock();
    const idle = now.getTime() - locked.lastActiveAt.getTime() > computerIdleMs;
    const markAsleepIn = async (synced: Awaited<ReturnType<typeof syncFiles>>) => {
      await tx
        .update(computerTable)
        .set({ state: "asleep", ...synced })
        .where(eq(computerTable.userId, userId));
    };
    if (idle && !(await isBusy(busyChecks, userId, locked.lastActiveAt))) {
      const synced = await syncFiles(sdk, provider, sandboxId, locked);
      const gone = await isGone(() => provider.pause(sandboxId));
      // A gone sandbox's sync failed, so nothing new is recorded.
      await markAsleepIn(gone ? null : synced);
      return;
    }
    if (await isGone(() => provider.setTimeout(sandboxId, backstopTimeoutMs))) {
      await markAsleepIn(null);
      return;
    }
    const followUpAt = new Date(
      Math.max(locked.lastActiveAt.getTime() + computerIdleMs, now.getTime() + followUpAtLeastMs),
    );
    await armSleepCheck(sdk, userId, followUpAt, tx);
  });
}

/** Runs a provider call on a sandbox, and returns whether the sandbox was gone. */
async function isGone(call: () => Promise<void>): Promise<boolean> {
  try {
    await call();
    return false;
  } catch (caught) {
    if (caught instanceof SandboxGoneError) return true;
    throw caught;
  }
}

/** Whether any busy check says the Computer is in use. */
async function isBusy(checks: readonly BusyCheck[], userId: string, lastActiveAt: Date) {
  for (const check of checks) {
    if (await check(userId, lastActiveAt)) return true;
  }
  return false;
}

/**
 * Queues one sleep check of the user's Computer, due at `runAfter`: in `tx` when given, so it
 * exists only if that transaction commits (this needs the in-process runner, as `bot` does).
 */
async function armSleepCheck(
  sdk: BotSdkContext,
  userId: string,
  runAfter: Date,
  tx?: Transaction,
): Promise<void> {
  const runner = sdk.plugin("runner");
  if (tx) await runner.enqueueIn(tx, sleepJobName, { userId }, { runAfter });
  else await runner.enqueue(sleepJobName, { userId }, { runAfter });
}

/** `ms` after `time`. */
const after = (time: Date, ms: number) => new Date(time.getTime() + ms);

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
