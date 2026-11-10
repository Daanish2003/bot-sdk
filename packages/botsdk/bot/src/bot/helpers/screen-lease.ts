import { liveDemonstrationStates } from "@botsdk/client/bot/demonstration";
import { and, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import { botDemonstration, botHelper, job } from "../../storage";
import type { Database } from "../../storage";
import { uuidv7 } from "../../lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../plugin";
import { defineCoreJob } from "../../runner/internal";
import { ComputerOperationError, type ScreenControl } from "../../computer/internal";
import { computerOf } from "../agent-loop";

/** How long a lease outlives its last renewal, so a holder that crashed frees the slot. */
const screenLeaseTtlMs = 60_000;
const screenLeaseRenewMs = screenLeaseTtlMs / 3;
/** How often a call that wants a held slot looks again. */
const screenLeasePollMs = 100;
/**
 * How long a call waits for a held slot before it gives up: past one Screen command's 60 s limit, so
 * only a holder that is stuck, or a queue behind it, runs it out.
 */
export const screenLeaseWaitMs = 90_000;

/**
 * Why a Screen command didn't run, as the cause of its `ComputerOperationError`: another command
 * held the slot past `screenLeaseWaitMs`, or this process began to stop while it waited.
 */
export class ScreenBusyError extends Error {
  constructor(slot: number) {
    super(`Screen ${slot} is busy: another command on it hasn't finished. Try again in a moment.`);
    this.name = "ScreenBusyError";
  }
}

const screenLeaseJobName = "bot.screen.lease";

/**
 * A Screen slot's lease: a queued job, due only once the lease has run out. The job table's unique
 * active idempotency key lets one process hold a slot. A crashed holder's lease is taken over by the
 * next call that wants the slot; with none, the job comes due, does nothing, and so ends.
 */
export const screenLeaseJob = defineCoreJob({
  name: screenLeaseJobName,
  payload: z.object({}),
  run: async () => {},
});

/**
 * Runs `act` while holding the user's Screen `slot`'s lease, so sandbox commands for one slot run one
 * at a time across processes. No database connection is held meanwhile: a call that waits polls
 * between short statements, since a sandbox call can wake the Computer, which needs the pool too.
 * It throws a `ComputerOperationError` caused by `ScreenBusyError`, with `act` not run, once the wait
 * passes `screenLeaseWaitMs` or the process is stopping, so a stuck holder can't hold up its callers.
 */
export async function withScreenLease<T>(
  deps: BotSdkContext,
  userId: string,
  slot: number,
  act: () => Promise<T>,
): Promise<T> {
  const id = uuidv7();
  const key = `screen-lease:${userId}:${slot}`;
  const until = () => new Date(deps.clock().getTime() + screenLeaseTtlMs);
  const giveUpAt = deps.clock().getTime() + screenLeaseWaitMs;
  for (;;) {
    const now = deps.clock();
    const taken = await deps.db
      .insert(job)
      .values({
        id,
        name: screenLeaseJobName,
        payload: {},
        idempotencyKey: key,
        runAfter: until(),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: job.id });
    if (taken.length > 0) break;
    // A due lease lost its holder. Taken over here, so the slot never waits for a runner's lane.
    const expired = await deps.db
      .delete(job)
      .where(
        and(eq(job.idempotencyKey, key), eq(job.status, "queued"), lte(job.runAfter, deps.clock())),
      )
      .returning({ id: job.id });
    if (expired.length > 0) continue;
    if (deps.lifecycle.stopping || deps.clock().getTime() >= giveUpAt) {
      throw new ComputerOperationError(new ScreenBusyError(slot));
    }
    await new Promise((resolve) => setTimeout(resolve, screenLeasePollMs));
  }
  const renewal = setInterval(() => {
    deps.db
      .update(job)
      .set({ runAfter: until() })
      .where(and(eq(job.id, id), eq(job.status, "queued")))
      .catch((caught: unknown) => deps.logger.error("Renewing a Screen's lease failed", caught));
  }, screenLeaseRenewMs);
  renewal.unref?.();
  try {
    return await act();
  } finally {
    clearInterval(renewal);
    // A failed release only leaves the lease to run out.
    await deps.db
      .delete(job)
      .where(eq(job.id, id))
      .catch((caught: unknown) => deps.logger.error("Releasing a Screen's lease failed", caught));
  }
}

/** Whether the Helper or Demonstration `id` hasn't ended, so the slot it was given is still its. */
export async function holdsItsScreen(db: Database | Transaction, id: string): Promise<boolean> {
  const [helper] = await db
    .select({ id: botHelper.id })
    .from(botHelper)
    .where(and(eq(botHelper.id, id), inArray(botHelper.status, ["running", "waiting"])));
  if (helper) return true;
  const [demonstration] = await db
    .select({ id: botDemonstration.id })
    .from(botDemonstration)
    .where(
      and(
        eq(botDemonstration.id, id),
        inArray(botDemonstration.state, [...liveDemonstrationStates]),
      ),
    );
  return demonstration !== undefined;
}

/**
 * Switches Screen `holder.slot`'s control to `mode`, for the Helper `holder.id` that was given it,
 * under the slot's lease. Does nothing once the holder has ended: the slot may be the next holder's.
 */
export async function controlHeldScreen(
  deps: BotSdkContext,
  holder: { id: string; userId: string; slot: number },
  mode: ScreenControl,
): Promise<void> {
  await withScreenLease(deps, holder.userId, holder.slot, async () => {
    if (!(await holdsItsScreen(deps.db, holder.id))) return;
    await computerOf(deps, holder.userId).setScreenControl(holder.slot, mode);
  });
}
