import { eq } from "drizzle-orm";
import { z } from "zod";

import { computer as computerTable } from "../../../core/server/db/schema";
import type { BotSdkContext, BotSdkPlugin, Transaction } from "../../../core/server/plugin";
import { defineJob } from "../../runner/server/jobs/define";
import { cancelQueuedJobsIn } from "../../runner/server/jobs/store";
import type { CommandResult, ComputerProvider } from "./provider";

/** A Computer whose last activity is older than this is idle, so its sleep check may pause it. */
export const computerIdleMs = 5 * 60_000;

/** The soonest a check that kept the Computer awake checks again. */
const followUpAtLeastMs = 60_000;

/**
 * The provider's own timeout, after which the sandbox pauses itself: set by each create and resume,
 * and extended by each check that keeps the Computer awake, so a dead server still lets it sleep.
 */
const backstopTimeoutMs = 60 * 60_000;

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
 * One user's Computer. Every operation wakes it first when it isn't awake (a first create, or a
 * resume), and records activity when it starts and when it finishes.
 */
export type ComputerHandle = {
  /** Runs `command` with `bash -l -c` in `cwd` (the home directory by default). */
  run: (command: string, options?: { cwd?: string }) => Promise<CommandResult>;
};

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
      const busyChecks: BusyCheck[] = [];
      const api: ComputerApi = {
        forUser: (userId) => ({
          run: async (command, options = {}) => {
            const sandboxId = await startOperation(sdk, provider, userId);
            try {
              return await provider.run(sandboxId, command, { cwd: options.cwd });
            } finally {
              await recordActivity(sdk, userId);
            }
          },
        }),
        addBusyCheck: (check) => {
          busyChecks.push(check);
        },
      };
      sleepChecks.set(api, (userId) => sleepCheck(sdk, provider, busyChecks, userId));
      return { api };
    },
    // The row goes with its user, with its queued sleep checks, and its sandbox id is collected.
    // Killing that sandbox after the commit is the user delete ticket's (#525). A check that runs
    // anyway finds no row and ends.
    deleteUser: {
      before: async (sdk, { userId, tx }) => {
        await cancelQueuedJobsIn(tx, sleepJobName, { field: "userId", value: userId }, sdk.clock());
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
 * returns the sandbox to act on, waking the Computer first when it isn't awake. While a sleep
 * check holds the row lock, the update waits for it, then sees `asleep` and wakes the Computer.
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
 * uses its sandbox. A wake arms one sleep check in its transaction, so the check exists exactly
 * when the Computer became awake.
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
    let sandboxId = locked.sandboxId;
    if (sandboxId) {
      await provider.resume(sandboxId, { timeoutMs: backstopTimeoutMs });
      await tx
        .update(computerTable)
        .set({ state: "awake" })
        .where(eq(computerTable.userId, userId));
    } else {
      ({ sandboxId } = await provider.create({ timeoutMs: backstopTimeoutMs }));
      await tx
        .update(computerTable)
        .set({ state: "awake", sandboxId, template: provider.template })
        .where(eq(computerTable.userId, userId));
    }
    await armSleepCheck(sdk, userId, after(sdk.clock(), computerIdleMs), tx);
    return sandboxId;
  });
}

/**
 * One sleep check, under the row lock until it commits, so an operation that arrives meanwhile
 * waits and then wakes the Computer. An asleep Computer's chain ends. An idle one that no busy
 * check holds is paused and marked `asleep`; a failed pause throws before the row changes, so the
 * runner retries. Otherwise the provider's timeout is extended and one follow-up is armed, in the
 * same transaction, so the chain can't end while the Computer stays awake.
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
    const now = sdk.clock();
    const idle = now.getTime() - locked.lastActiveAt.getTime() > computerIdleMs;
    if (idle && !(await isBusy(busyChecks, userId, locked.lastActiveAt))) {
      await provider.pause(locked.sandboxId);
      await tx
        .update(computerTable)
        .set({ state: "asleep" })
        .where(eq(computerTable.userId, userId));
      return;
    }
    await provider.setTimeout(locked.sandboxId, backstopTimeoutMs);
    const followUpAt = new Date(
      Math.max(locked.lastActiveAt.getTime() + computerIdleMs, now.getTime() + followUpAtLeastMs),
    );
    await armSleepCheck(sdk, userId, followUpAt, tx);
  });
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
