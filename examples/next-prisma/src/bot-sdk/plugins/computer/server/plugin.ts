import { createHash, randomBytes } from "node:crypto";

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
  type Endpoint,
  type FileEntry,
  SandboxGoneError,
  type TimedOutCommand,
} from "./provider";

/** How long a command may run when its caller doesn't say: 60 seconds. */
export const defaultCommandTimeoutMs = 60_000;

/** A Computer whose last activity is older than this is idle, so its sleep check may pause it. */
export const computerIdleMs = 5 * 60_000;

/**
 * How often a running operation records activity, well inside `computerIdleMs`, so a sleep check
 * in any process sees it active for as long as it runs (#558).
 */
export const activityHeartbeatMs = 60_000;

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

/** The most Screens a Computer holds at once. */
export const maxScreens = 4;

/** A Screen's ports inside the sandbox, from the template's `ai-chat-screen` script. */
const novncPort = (slot: number) => 6080 + slot;
const cdpPort = (slot: number) => 9222 + slot;

/** Where a Screen's link token is kept in the sandbox, for `screenUrls` and the start script. */
const screenTokenPath = (slot: number) => `/tmp/screens/${slot}/token`;

const screenScript = "/usr/local/bin/ai-chat-screen";

/** How long the start script, which waits for Chromium's DevTools port, may run. */
const screenCommandTimeoutMs = 60_000;

function assertProfileKey(profileKey: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(profileKey)) {
    throw new RangeError("A profile key is letters, digits, - and _");
  }
}

function assertSlot(slot: number) {
  if (!Number.isInteger(slot) || slot < 1 || slot > maxScreens) {
    throw new RangeError(`Screen slot must be 1 to ${maxScreens}, got ${slot}`);
  }
}

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
 * Whether the user still holds something that uses their Computer (`bot`: a Bot), read in `tx`
 * under a lock that the user's delete waits for, or that waits for it.
 */
export type OwnerCheck = (tx: Transaction, userId: string) => Promise<boolean>;

/**
 * The Computer's latest rebuild: at `rebuiltAt`, a wake built it again from its template and
 * restored its synced files as of `restoredAsOf`. That is null when there was no archive, so it
 * started empty, and undefined once a later sync stored a newer archive: the row then no longer
 * says whether the rebuild restored one or started empty.
 */
export type Rebuild = { rebuiltAt: Date; restoredAsOf: Date | null | undefined };

/**
 * One user's Computer. Every operation wakes it first when it isn't awake (a first create, a
 * resume, or a rebuild), and records activity when it starts, every `activityHeartbeatMs` while
 * it runs, and when it finishes. The first operation creates the Computer only while an owner
 * check holds, if any plugin added one; otherwise it throws `ComputerUnavailableError`. An operation
 * whose wake fails throws `ComputerUnavailableError`, and nothing runs. One the provider fails
 * (a permission denied, a read of a directory) throws `ComputerOperationError`; one whose sandbox
 * turns out gone rebuilds it and runs once more. A stop rethrows its reason as it is.
 */
export type ComputerHandle = {
  /**
   * The Computer's latest rebuild, as this handle's latest operation found it: null before an
   * operation, or when it was never rebuilt. Whoever uses it says it once (`bot` keeps per Bot).
   */
  rebuild: () => Rebuild | null;
  /**
   * Runs `command` with `bash -l -c` in `cwd` (the home directory by default). A command still
   * running after `timeoutMs` (`defaultCommandTimeoutMs` when unset) or at `deadline`, whichever
   * comes first, is killed and returns what it printed so far; the wake's time counts toward
   * `deadline`. Once `signal` aborts, the command is killed and `run` throws its reason. `envs` are
   * environment variables for this one command only. `redact` are strings replaced with `***` in
   * the output before it is cut down to its ends, so none is half kept by the cut.
   */
  run: (
    command: string,
    options?: {
      cwd?: string;
      timeoutMs?: number;
      deadline?: Date;
      signal?: AbortSignal;
      envs?: Record<string, string>;
      redact?: string[];
    },
  ) => Promise<CommandResult | TimedOutCommand>;
  /** A file's bytes, or null when there is no such file. */
  readFile: (path: string, options?: FileOperationOptions) => Promise<Uint8Array | null>;
  /** Writes a file, creating any missing parent directories, and overwrites it. */
  writeFile: (
    path: string,
    content: string | Uint8Array,
    options?: FileOperationOptions,
  ) => Promise<void>;
  /** A directory's entries, one level deep, or null when there is no such directory. */
  list: (path: string, options?: FileOperationOptions) => Promise<FileEntry[] | null>;
  /**
   * Opens Screen `slot` (1 to 4): a 1280x800 display with its own Chromium, started on the Chrome
   * profile `profileKey` (letters, digits, `-` and `_`), an x11vnc that is view-only and a noVNC
   * reached only with a fresh token. An open Screen is reopened (its processes restarted, view-only
   * again, its profile kept). Chrome profiles live in `/home/user/.chrome-profiles`, outside the synced
   * trees, so they are never sent to server storage and a rebuild loses them.
   */
  openScreen: (slot: number, profileKey: string) => Promise<void>;
  /** Closes Screen `slot`: kills its processes. Its profile stays on disk. */
  closeScreen: (slot: number) => Promise<void>;
  /**
   * An open Screen's Chromium DevTools endpoint and its noVNC link, which carries the token that
   * `openScreen` made. Each comes with the headers a request to it must carry: the sandbox's
   * traffic access token, and whatever routes it to the sandbox and port, so a client never uses
   * one endpoint's headers for the other. Throws when the Screen isn't open.
   */
  screenUrls: (slot: number) => Promise<ScreenUrls>;
  /** Makes an open Screen's x11vnc view-only (`view`) or lets a viewer drive it (`control`). */
  setScreenControl: (slot: number, mode: ScreenControl) => Promise<void>;
  /**
   * Records activity now, without waking the Computer: a live view of a Screen calls it while it is
   * open, so the Computer stays awake while the user watches.
   */
  heartbeat: () => Promise<void>;
};

/**
 * The endpoints of one Screen: Chromium's DevTools, and the noVNC page (`url` is the page's link,
 * `vnc.html` with its query).
 */
export type ScreenUrls = { cdp: Endpoint; novnc: Endpoint };

/** Whether a Screen's viewer only watches, or drives it. */
export type ScreenControl = "view" | "control";

/**
 * A file operation's stop: once `signal` aborts, the operation throws its reason before it
 * reaches the provider, and a gone sandbox is not rebuilt for it. One the provider has started
 * runs to its end.
 */
export type FileOperationOptions = { signal?: AbortSignal };

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

/**
 * What `screenUrls` fails with, as the cause of its `ComputerOperationError`, when the Screen isn't
 * open (never opened, closed, or lost to a rebuild).
 */
export class ScreenNotOpenError extends Error {
  constructor(slot: number) {
    super(`Screen ${slot} is not open`);
    this.name = "ScreenNotOpenError";
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
  /**
   * Adds an owner check. Once any is added, a user's Computer is created only while one of them
   * holds, so an operation that races the user's delete creates nothing (#554). A plugin that
   * uses the Computer for a user without a Bot adds its own.
   */
  addOwnerCheck: (check: OwnerCheck) => void;
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
      const ownerChecks: OwnerCheck[] = [];
      const api: ComputerApi = {
        forUser: (userId) => {
          let latestRebuild: Rebuild | null = null;
          const operate = async <T>(
            act: (sandboxId: string) => Promise<T>,
            signal?: AbortSignal,
          ) => {
            let woken = await startOperation(sdk, provider, ownerChecks, userId);
            const heartbeat = startHeartbeat(sdk, userId);
            try {
              for (let retried = false; ; retried = true) {
                latestRebuild = woken.rebuild;
                try {
                  return await act(woken.sandboxId);
                } catch (caught) {
                  if (signal?.aborted) throw caught;
                  if (caught instanceof SandboxGoneError) {
                    // A rebuilt sandbox gone too: the Computer couldn't start.
                    if (retried) throw new ComputerUnavailableError(userId, caught);
                    // The row said awake, but the sandbox is gone: the wake rebuilds it, once.
                    await markAsleep(sdk, userId, woken.sandboxId);
                    woken = await wake(sdk, provider, userId);
                    continue;
                  }
                  throw new ComputerOperationError(caught);
                }
              }
            } finally {
              await heartbeat.stop();
              await recordActivity(sdk, userId);
            }
          };
          /** Runs the template's `ai-chat-screen` script, failing on a non-zero exit. */
          const screenCommand = (id: string, args: string) =>
            provider
              .run(id, `${screenScript} ${args}`, { timeoutMs: screenCommandTimeoutMs })
              .then((result) => {
                if ("timedOut" in result || result.exitCode !== 0) {
                  const detail = "timedOut" in result ? "timed out" : result.stderr.trim();
                  throw new Error(`${screenScript} ${args} failed: ${detail}`);
                }
              });
          return {
            rebuild: () => latestRebuild,
            openScreen: async (slot, profileKey) => {
              assertSlot(slot);
              assertProfileKey(profileKey);
              return operate(async (id) => {
                await provider.writeFile(
                  id,
                  screenTokenPath(slot),
                  randomBytes(24).toString("hex"),
                );
                await screenCommand(id, `start ${slot} ${profileKey}`);
              });
            },
            closeScreen: async (slot) => {
              assertSlot(slot);
              return operate((id) => screenCommand(id, `stop ${slot}`));
            },
            screenUrls: async (slot) => {
              assertSlot(slot);
              return operate(async (id) => {
                const token = await provider.readFile(id, screenTokenPath(slot));
                if (!token) throw new ScreenNotOpenError(slot);
                const [novnc, cdp] = await Promise.all([
                  provider.endpoint(id, novncPort(slot)),
                  provider.endpoint(id, cdpPort(slot)),
                ]);
                const query = new URLSearchParams({
                  path: `websockify?token=${new TextDecoder().decode(token)}`,
                  autoconnect: "1",
                  resize: "scale",
                });
                return { cdp, novnc: { ...novnc, url: `${novnc.url}/vnc.html?${query}` } };
              });
            },
            setScreenControl: async (slot, mode) => {
              assertSlot(slot);
              return operate((id) => screenCommand(id, `${mode} ${slot}`));
            },
            heartbeat: () => recordActivity(sdk, userId),
            run: (
              command,
              { cwd, timeoutMs = defaultCommandTimeoutMs, deadline, signal, envs, redact } = {},
            ) =>
              operate((id) => {
                // A stop during the wake runs nothing.
                signal?.throwIfAborted();
                const left = deadline ? deadline.getTime() - sdk.clock().getTime() : timeoutMs;
                const limitMs = Math.max(0, Math.min(timeoutMs, left));
                return provider.run(id, command, {
                  cwd,
                  timeoutMs: limitMs,
                  signal,
                  ...(envs && { envs }),
                  ...(redact && { redact }),
                });
              }, signal),
            // A stop during the wake reaches no provider call, as with `run`.
            readFile: (path, { signal } = {}) =>
              operate((id) => {
                signal?.throwIfAborted();
                return provider.readFile(id, path);
              }, signal),
            writeFile: (path, content, { signal } = {}) =>
              operate((id) => {
                signal?.throwIfAborted();
                return provider.writeFile(id, path, content);
              }, signal),
            list: (path, { signal } = {}) =>
              operate((id) => {
                signal?.throwIfAborted();
                return provider.list(id, path);
              }, signal),
          };
        },
        addBusyCheck: (check) => {
          busyChecks.push(check);
        },
        addOwnerCheck: (check) => {
          ownerChecks.push(check);
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

/** What an operation's start reads of the row. */
const startColumns = {
  state: computerTable.state,
  sandboxId: computerTable.sandboxId,
  rebuiltAt: computerTable.rebuiltAt,
  syncedAt: computerTable.syncedAt,
};

/**
 * An operation's start: records activity, creating the row on the user's first operation, and
 * returns the sandbox to act on, waking the Computer first when it isn't awake. While a sleep
 * check holds the row lock, the update waits for it, then sees `asleep` and wakes the Computer.
 * A user delete's lock is waited for the same way, and then the row is gone.
 */
async function startOperation(
  sdk: BotSdkContext,
  provider: ComputerProvider,
  ownerChecks: readonly OwnerCheck[],
  userId: string,
): Promise<Woken> {
  const now = sdk.clock();
  const [row] = await sdk.db
    .update(computerTable)
    .set({ lastActiveAt: now })
    .where(eq(computerTable.userId, userId))
    .returning(startColumns);
  const started = row ?? (await createRow(sdk, ownerChecks, userId, now));
  if (started.state === "awake" && started.sandboxId) {
    return { sandboxId: started.sandboxId, rebuild: rebuildOf(started) };
  }
  return wake(sdk, provider, userId);
}

/**
 * Creates the user's row on their first operation, while an owner check holds, in one
 * transaction with the checks' locks: a user delete that removed what they hold makes it throw
 * `ComputerUnavailableError`, and one that waits for this commit deletes the row it creates. That
 * needs the owners' `deleteUser.before` to run before this plugin's, as a plugin that `uses`
 * computer does (the hooks run in reverse dependency order).
 */
async function createRow(
  sdk: BotSdkContext,
  ownerChecks: readonly OwnerCheck[],
  userId: string,
  now: Date,
) {
  return sdk.db.transaction(async (tx) => {
    if (ownerChecks.length > 0 && !(await isOwned(ownerChecks, tx, userId))) {
      throw new ComputerUnavailableError(userId, new Error("Nothing of the user uses a Computer"));
    }
    const [row] = await tx
      .insert(computerTable)
      .values({ userId, state: "asleep", lastActiveAt: now, createdAt: now })
      .onConflictDoUpdate({ target: computerTable.userId, set: { lastActiveAt: now } })
      .returning(startColumns);
    if (!row) throw new Error(`Creating the Computer of user ${userId} returned no row`);
    return row;
  });
}

/** Whether any owner check says the user still holds something that uses the Computer. */
async function isOwned(checks: readonly OwnerCheck[], tx: Transaction, userId: string) {
  for (const check of checks) {
    if (await check(tx, userId)) return true;
  }
  return false;
}

/** The latest rebuild a row records, or null when it was never rebuilt. */
function rebuildOf({
  rebuiltAt,
  syncedAt,
}: {
  rebuiltAt: Date | null;
  syncedAt: Date | null;
}): Rebuild | null {
  if (!rebuiltAt) return null;
  // A rebuild restores the archive the row names, or none; a later sync replaces it.
  if (!syncedAt) return { rebuiltAt, restoredAsOf: null };
  return { rebuiltAt, restoredAsOf: syncedAt <= rebuiltAt ? syncedAt : undefined };
}

/** The sandbox an operation acts on, and the Computer's latest rebuild, if any. */
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
      // A user delete that committed since the operation started removed it: nothing to wake.
      if (!locked) {
        throw new ComputerUnavailableError(userId, new Error("The Computer has no row"));
      }
      if (locked.state === "awake" && locked.sandboxId) {
        return {
          woken: { sandboxId: locked.sandboxId, rebuild: rebuildOf(locked) },
          replaced: null,
        };
      }
      let woken: Woken;
      // What a rebuild changes on the row besides the sandbox: the rebuild, and a lost archive.
      let rebuilt: Partial<typeof computerTable.$inferInsert> = {};
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
        woken = { sandboxId: asleepId, rebuild: rebuildOf(locked) };
      } else {
        const { sandboxId, restored } = await rebuild(sdk, provider, locked);
        const rebuiltAt = sdk.clock();
        woken = { sandboxId, rebuild: { rebuiltAt, restoredAsOf: restored } };
        // A missing archive can't be restored again, so the sync record goes with it.
        rebuilt = restored
          ? { rebuiltAt }
          : { rebuiltAt, syncedAt: null, syncFingerprint: null, syncedBytes: null };
      }
      if (woken.sandboxId !== asleepId) created = woken.sandboxId;
      await tx
        .update(computerTable)
        .set({
          state: "awake",
          sandboxId: woken.sandboxId,
          template: provider.template,
          ...rebuilt,
        })
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

/**
 * Marks the Computer asleep while its row still names `sandboxId`, gone, so the next wake rebuilds
 * it, and cancels the queued sleep checks of the awake period it ends: the wake arms a fresh one.
 */
async function markAsleep(sdk: BotSdkContext, userId: string, sandboxId: string) {
  await sdk.db.transaction(async (tx) => {
    const marked = await tx
      .update(computerTable)
      .set({ state: "asleep" })
      .where(
        and(
          eq(computerTable.userId, userId),
          eq(computerTable.sandboxId, sandboxId),
          eq(computerTable.state, "awake"),
        ),
      )
      .returning({ userId: computerTable.userId });
    if (marked.length === 0) return;
    await cancelQueuedJobsIn(tx, sleepJobName, { field: "userId", value: userId }, sdk.clock());
  });
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
 * directory, returning the new sandbox and the archive's time; with no archive, it starts empty
 * (`restored` null). A failed restore kills the new sandbox and throws `ComputerUnavailableError`,
 * so the wake fails instead of handing back a Computer without files.
 */
async function rebuild(
  sdk: BotSdkContext,
  provider: ComputerProvider,
  row: typeof computerTable.$inferSelect,
): Promise<{ sandboxId: string; restored: Date | null }> {
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
    return { sandboxId, restored: archive ? row.syncedAt : null };
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
    // A gone sandbox has nothing to sync; the pause that follows finds it gone too.
    if (!(caught instanceof SandboxGoneError)) {
      sdk.logger.error(`Syncing the files of the Computer of user ${userId} failed`, caught);
    }
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
 * Records activity every `activityHeartbeatMs` while an operation runs, in the row, so a sleep
 * check in another process sees it too; `stop` ends it and waits for a write in flight.
 */
function startHeartbeat(sdk: BotSdkContext, userId: string) {
  let beating: Promise<void> | undefined;
  const timer = setInterval(() => {
    beating ??= recordActivity(sdk, userId).finally(() => (beating = undefined));
  }, activityHeartbeatMs);
  // A stuck operation must not keep the process alive on its own.
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      await beating;
    },
  };
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
