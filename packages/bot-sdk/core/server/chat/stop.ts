import { eq } from "drizzle-orm";

import { message } from "../db/schema/chat";
import type { AppDeps } from "../deps";

/**
 * How long a Run may go without a heartbeat before it counts as ended (ADR 0006). Until the owner
 * writes `heartbeat_at`, a Run counts from its creation.
 */
export const HEARTBEAT_LEASE_MS = 30_000;

/** The channel a Run's Stop signal is published on. */
export const cancelChannel = (runId: string) => `run:${runId}:cancel`;

/** Whether a Run's last heartbeat is older than the lease, so no owner is still writing it. */
export function heartbeatExpired(
  row: { heartbeatAt: Date | null; createdAt: Date },
  now = Date.now(),
): boolean {
  const lastSeen = row.heartbeatAt ?? row.createdAt;
  return now - lastSeen.getTime() > HEARTBEAT_LEASE_MS;
}

/**
 * Calls `onStop` when a Stop is published for the Run. The signal is at most once, so the owner
 * also reads the column (`stopRequested`). Resolves to the unsubscribe.
 */
export function listenForStop(
  deps: Pick<AppDeps, "pubsub">,
  runId: string,
  onStop: () => void,
): Promise<() => Promise<void>> {
  return deps.pubsub.subscribe(cancelChannel(runId), onStop);
}

/**
 * Whether a Stop has been saved on the Run's Message. The owner reads this on each snapshot tick,
 * so a Stop whose signal never reached it still lands within one snapshot interval.
 */
export async function stopRequested(deps: Pick<AppDeps, "db">, runId: string): Promise<boolean> {
  const [row] = await deps.db
    .select({ cancelRequestedAt: message.cancelRequestedAt })
    .from(message)
    .where(eq(message.id, runId));
  return Boolean(row?.cancelRequestedAt);
}
