import { and, eq, isNull, max, min, type SQL } from "drizzle-orm";

import {
  bot,
  botTrigger,
  botTurn,
  conversation,
  job,
  jobEvent,
  message,
} from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";

/** The runner job that runs one Turn (`botTurnJob` in `turn.ts`). */
export const botTurnJobName = "bot.turn";

/**
 * Batching quick Messages (#501): a Turn's job starts once `batchQuietMs` pass with no new Trigger,
 * and never later than `batchLongestMs` after the first Trigger it took. There is no cap. The
 * lecture leaves the heuristic open, so these are a recorded deviation: 500 ms is OpenClaw's queue
 * debounce default, and 2.5 s is OpenClaw's rule that a batch closes at 5 × the debounce. Hermes's
 * 0.35 s / 1.0 s was rejected as tuned for a fast phone typist, too tight for three deliberate
 * Messages (#497).
 */
export const batchQuietMs = 500;
export const batchLongestMs = 2_500;

/** A Trigger as the Router receives it: its row, before any Turn has taken it. */
export type ReceivedTrigger = Omit<typeof botTrigger.$inferInsert, "turnId">;

/** The Conversation queue (#499): the Conversation's Triggers that no Turn has taken yet. */
export function waitingIn(conversationId: string): SQL | undefined {
  return and(eq(botTrigger.conversationId, conversationId), isNull(botTrigger.turnId));
}

/**
 * Takes the Conversation's row lock. Every transaction that starts or ends a Turn takes it first,
 * so a Conversation runs one Turn at a time (#499); the running-Turn index backs it up.
 */
export async function lockConversation(tx: Transaction, conversationId: string): Promise<void> {
  await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .for("update");
}

/**
 * The Router's way in (#499): queues the Trigger in its Conversation queue and, when no Turn is
 * running, starts one that takes it. While the running Turn's job hasn't started, the Trigger joins
 * that Turn and pushes back its job (#501). Returns `takenBy`, the Turn that took it, or, when the
 * Trigger waits for the Turn that follows the running one, `waitsFor`, that running Turn. Call the
 * runner's `wake()` once `tx` has committed.
 */
export async function receive(
  deps: BotSdkContext,
  tx: Transaction,
  trigger: ReceivedTrigger,
): Promise<{ takenBy?: string; waitsFor?: string }> {
  await lockConversation(tx, trigger.conversationId);
  await tx.insert(botTrigger).values(trigger);
  const [running] = await tx
    .select({ id: botTurn.id, jobId: botTurn.jobId })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(and(eq(bot.conversationId, trigger.conversationId), eq(botTurn.status, "running")))
    .limit(1);
  if (!running) return { takenBy: await startTurn(deps, tx, trigger.conversationId) };
  if (!(await jobNotStarted(tx, running.jobId))) return { waitsFor: running.id };
  await tx.update(botTrigger).set({ turnId: running.id }).where(eq(botTrigger.id, trigger.id));
  // The runner has no reschedule: the queued job is cancelled and a replacement queued, in this
  // transaction, and the Turn is relinked to it.
  const runner = deps.plugin("runner");
  await runner.cancelIn(tx, running.id);
  const jobId = await enqueueTurnJob(deps, tx, running.id, eq(botTrigger.turnId, running.id));
  await tx.update(botTurn).set({ jobId }).where(eq(botTurn.id, running.id));
  return { takenBy: running.id };
}

/**
 * Whether a Turn's job is queued, has used no attempt and has recorded no Checkpoint, so replacing
 * it loses nothing. The job's row is locked, so no runner claims it before this transaction ends. A
 * job queued again after an attempt is never replaced: a retry or a crash used an attempt, which a
 * replacement would give back, and a deploy's yield (which puts its attempt back) kept Checkpoints.
 */
async function jobNotStarted(tx: Transaction, jobId: string | null): Promise<boolean> {
  if (!jobId) return false;
  const [row] = await tx
    .select({ status: job.status, attempts: job.attempts })
    .from(job)
    .where(eq(job.id, jobId))
    .for("update");
  if (row?.status !== "queued" || row.attempts > 0) return false;
  const [recorded] = await tx
    .select({ seq: jobEvent.seq })
    .from(jobEvent)
    .where(eq(jobEvent.jobId, jobId))
    .limit(1);
  return !recorded;
}

/**
 * Queues the job of Turn `turnId`, to run once the batch of `triggers` is closed (#501): `batchQuietMs`
 * after the newest, and no later than `batchLongestMs` after the first. Returns the job's id.
 */
async function enqueueTurnJob(
  deps: BotSdkContext,
  tx: Transaction,
  turnId: string,
  triggers: SQL | undefined,
): Promise<string> {
  const [batch] = await tx
    .select({ first: min(botTrigger.receivedAt), newest: max(botTrigger.receivedAt) })
    .from(botTrigger)
    .where(triggers);
  const now = deps.clock().getTime();
  const first = batch?.first?.getTime() ?? now;
  const newest = batch?.newest?.getTime() ?? now;
  const runAfter = Math.min(newest + batchQuietMs, first + batchLongestMs);
  const runner = deps.plugin("runner");
  const jobId = await runner.enqueueIn(
    tx,
    botTurnJobName,
    { turnId },
    { idempotencyKey: turnId, runAfter: new Date(runAfter) },
  );
  // The runner polls every few seconds, so it is woken when the job falls due. By then `tx` has
  // long committed; if not, the next poll claims the job.
  if (runAfter > now) setTimeout(() => runner.wake(), runAfter - now).unref?.();
  return jobId;
}

/**
 * Chains the next Turn (#499), in the transaction that ended `turnId`: if Triggers wait in its
 * Conversation queue, a new Turn takes all of them. Returns that Turn's id, or `undefined` when the
 * queue is empty. Call the runner's `wake()` once `tx` has committed.
 */
export async function turnEnded(
  deps: BotSdkContext,
  tx: Transaction,
  turnId: string,
): Promise<string | undefined> {
  const [ended] = await tx
    .select({ conversationId: bot.conversationId })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(eq(botTurn.id, turnId));
  if (!ended) return undefined;
  await lockConversation(tx, ended.conversationId);
  return startTurn(deps, tx, ended.conversationId);
}

/** Creates a Turn that takes every Trigger waiting in the Conversation queue, and queues its job. */
async function startTurn(
  deps: BotSdkContext,
  tx: Transaction,
  conversationId: string,
): Promise<string | undefined> {
  const waiting = waitingIn(conversationId);
  const [first] = await tx.select({ id: botTrigger.id }).from(botTrigger).where(waiting).limit(1);
  if (!first) return undefined;
  const [owner] = await tx
    .select({ id: bot.id })
    .from(bot)
    .where(eq(bot.conversationId, conversationId));
  if (!owner) throw new Error(`Conversation ${conversationId} has no Bot`);
  // Until its job starts and sets it (`turnStarted`), the Turn starts after every Message its
  // Triggers carry, even one stamped by a process whose clock runs ahead.
  const [newest] = await tx
    .select({ at: max(message.createdAt) })
    .from(botTrigger)
    .innerJoin(message, eq(message.id, botTrigger.messageId))
    .where(waiting);
  const startedAt = Math.max(deps.clock().getTime(), newest?.at?.getTime() ?? 0) + 1;
  const turnId = uuidv7();
  const jobId = await enqueueTurnJob(deps, tx, turnId, waiting);
  await tx.insert(botTurn).values({
    id: turnId,
    botId: owner.id,
    status: "running",
    startedAt: new Date(startedAt),
    jobId,
  });
  await tx.update(botTrigger).set({ turnId }).where(waiting);
  return turnId;
}

/**
 * Starts Turn `turnId` (#501), in its job's first Checkpoint: sets its `startedAt` under the
 * Conversation's row lock. From then on Triggers wait for the next Turn, and the 5-minute limit
 * counts from it.
 */
export async function turnStarted(deps: BotSdkContext, tx: Transaction, turnId: string) {
  const [turn] = await tx
    .select({ conversationId: bot.conversationId })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(eq(botTurn.id, turnId));
  if (!turn) return;
  await lockConversation(tx, turn.conversationId);
  const messagesOf = (triggers: SQL | undefined) =>
    tx
      .select({ first: min(message.createdAt), newest: max(message.createdAt) })
      .from(botTrigger)
      .innerJoin(message, eq(message.id, botTrigger.messageId))
      .where(triggers);
  const [taken] = await messagesOf(eq(botTrigger.turnId, turnId));
  const [waiting] = await messagesOf(waitingIn(turn.conversationId));
  // The Turn's input is the user Messages saved before it starts. It starts after every Message its
  // Triggers carry, even one stamped by a process whose clock runs ahead, and before any that came
  // once the job was claimed: those wait for the next Turn.
  const now = deps.clock().getTime();
  const startedAt = Math.max(
    (taken?.newest?.getTime() ?? 0) + 1,
    Math.min(now, waiting?.first?.getTime() ?? now),
  );
  await tx
    .update(botTurn)
    .set({ startedAt: new Date(startedAt) })
    .where(eq(botTurn.id, turnId));
}
