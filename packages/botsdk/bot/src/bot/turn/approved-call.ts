import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { bot, botReview, botTrigger } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import { hasConnectorFeature } from "../../feature";
import { defineCoreJob, type JobContext, type CoreJobServices } from "../../runner/internal";
import { ComputerOperationError, ComputerUnavailableError } from "../../computer/internal";
import {
  capResult,
  computerOf,
  computerOperationError,
  computerUnavailableError,
  type FileToolOptions,
  runShell,
  type ShellInput,
  shellToolName,
  spillPath,
} from "../agent-loop";
import { featureTools, featureTurnOf } from "../context";
import { hintChanged } from "../conversation";
import { lockConversation, receive } from "../triggers";
import { approvalTriggerId, approvalTriggerText, approvedCallJobName } from "../safety";

/*
 * The approved-call job (ADR 0030): when the user allows a call whose Approval went pending, it
 * runs the stored call outside any Turn, exactly as it was asked, with no second review, and wakes
 * the Bot with its result as an Approval Trigger. Whatever stops the call (a spent Quota, a broken
 * Connection, a failed command) is its result: it never retries the call.
 */

/** What the call's result is when the user's Quota is spent. */
export const approvedQuotaSpentError =
  "The approved call didn't run: the user's Quota is spent. Tell the user.";

/** What a call that started but has no result is, after a restart: it may have partly run. */
export const interruptedApprovedCallError =
  "The approved call was interrupted by a restart and may have partly run. Check its effects " +
  "before running it again.";

/** What the call is when the job gave up on it. */
export const failedApprovedCallError =
  "The approved call couldn't finish: it may not have run, or only partly. Check before trying " +
  "it again.";

/** What a call to a tool the Bot no longer has is. */
export const unavailableToolError = (tool: string) => `The tool ${tool} isn't available any more.`;

/** An allowed review's stored call, with its Bot. */
type StoredCall = {
  reviewId: string;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  userId: string;
  botId: string;
  model: string;
  conversationId: string;
};

export const approvedCallJob = defineCoreJob({
  name: approvedCallJobName,
  payload: z.object({ reviewId: z.uuid() }),
  run: async ({ reviewId }, ctx) => {
    const deps = ctx.deps;
    // A Bot deleted since took its review with it: there is no one to wake.
    const call = await storedCall(deps, reviewId);
    if (!call) return;
    const result = await runStoredCall(deps, ctx, call);
    const woke = await ctx.step("trigger", (tx) => wakeWith(deps, tx, call, result));
    if (!woke) return;
    deps.runner.wake();
    await hintChanged(deps, call.conversationId);
  },
  // A job that failed for good still wakes the Bot, so it never waits on the call.
  onFailed: async ({ reviewId }, _error, { deps }) => {
    const call = await storedCall(deps, reviewId);
    if (!call) return;
    const woke = await deps.db.transaction((tx) =>
      wakeWith(deps, tx, call, { error: failedApprovedCallError }),
    );
    if (!woke) return;
    deps.runner.wake();
    await hintChanged(deps, call.conversationId);
  },
});

/** Review `reviewId`'s stored call while it is `allowed`, with its Bot, or `null`. */
async function storedCall(deps: BotSdkContext, reviewId: string): Promise<StoredCall | null> {
  const [row] = await deps.db
    .select({
      reviewId: botReview.id,
      toolCallId: botReview.toolCallId,
      tool: botReview.tool,
      input: botReview.input,
      summary: botReview.summary,
      userId: bot.userId,
      botId: bot.id,
      model: bot.model,
      conversationId: bot.conversationId,
    })
    .from(botReview)
    .innerJoin(bot, eq(bot.id, botReview.botId))
    .where(and(eq(botReview.id, reviewId), eq(botReview.state, "allowed")));
  return row ?? null;
}

/**
 * Runs the stored call once: the Quota first, then the one tool it names, rebuilt for its Bot.
 * The start marker means a call a crash cut off is never run again: its result says it may have
 * partly run.
 */
async function runStoredCall(
  deps: BotSdkContext,
  ctx: JobContext<CoreJobServices>,
  call: StoredCall,
): Promise<unknown> {
  // As a Turn's start checks it: the result wakes a Turn on the Bot's Model.
  const quotaSpent = await ctx.step("quota", async () => {
    const model = await deps.models.resolveModelCall(call.userId, call.model);
    return model ? !(await model.meter.mayRun()).ok : false;
  });
  if (quotaSpent) return { error: approvedQuotaSpentError };
  // Closes whatever the call opened (a Connection's client) once it ends, or on a cancel.
  const connections = new AbortController();
  const cancel = () => connections.abort();
  ctx.signal.addEventListener("abort", cancel, { once: true });
  try {
    const run =
      call.tool === shellToolName
        ? shellCall(deps, call, connections.signal)
        : await connectorCall(deps, ctx, call, connections.signal);
    if (typeof run !== "function") return run;
    let startedHere = false;
    await ctx.step(
      "call_start",
      async () => {
        startedHere = true;
        return null;
      },
      { yields: false },
    );
    // No transaction: the call runs on the Computer or a Connection, not in the database.
    return await ctx.step("call", async () => {
      if (!startedHere) return { error: interruptedApprovedCallError };
      return run();
    });
  } finally {
    ctx.signal.removeEventListener("abort", cancel);
    connections.abort();
  }
}

/** The stored `shell` call, as a Turn runs it: its Secrets, masking and cut. */
function shellCall(deps: BotSdkContext, call: StoredCall, signal: AbortSignal) {
  const onComputer = async <T extends object>(
    operate: (computer: ReturnType<typeof computerOf>, live: FileToolOptions) => Promise<T>,
  ): Promise<T | { error: string }> => {
    if (!deps.computer) return { error: computerUnavailableError };
    try {
      return await operate(computerOf(deps, call.userId), { signal });
    } catch (caught) {
      if (!signal.aborted) {
        if (caught instanceof ComputerUnavailableError) return { error: computerUnavailableError };
        if (caught instanceof ComputerOperationError) {
          return { error: computerOperationError(caught.message) };
        }
      }
      throw caught;
    }
  };
  return () =>
    runShell(
      deps,
      { userId: call.userId, botId: call.botId, toolCallId: call.toolCallId },
      call.input as ShellInput,
      new Map(),
      onComputer,
    );
}

/**
 * The stored Connector tool call: the user's Connector tools listed afresh (a recorded activity),
 * and the one it names. A Connection that is down now, or no longer offers the tool, is the error.
 */
async function connectorCall(
  deps: BotSdkContext,
  ctx: JobContext<CoreJobServices>,
  call: StoredCall,
  signal: AbortSignal,
): Promise<(() => Promise<unknown>) | { error: string }> {
  if (!hasConnectorFeature(deps)) return { error: unavailableToolError(call.tool) };
  const connectors = await featureTools(
    deps,
    featureTurnOf({
      id: call.reviewId,
      userId: call.userId,
      botId: call.botId,
      conversationId: call.conversationId,
    }),
    // Run as it is: the user approved this very call, so it is never reviewed again.
    (_name, _toolCallId, run) => run(),
    new Set([shellToolName]),
    [],
    {
      signal,
      record: (featureId, list) => ctx.step(`${featureId}:tools`, list),
      computerCall: async () => ({ error: computerUnavailableError }),
    },
    { connectorsOnly: true },
  );
  const tool = connectors.tools.find((each) => each.name === call.tool);
  const execute = tool?.execute;
  if (!execute) {
    return { error: connectors.missing(call.tool) ?? unavailableToolError(call.tool) };
  }
  return async () => {
    const result = await execute(call.input, { toolCallId: call.toolCallId } as never);
    const computer = deps.computer ? computerOf(deps, call.userId) : undefined;
    return capResult(
      result,
      spillPath(call.botId, call.toolCallId),
      computer && ((path, content) => computer.writeFile(path, content, { signal })),
    );
  };
}

/**
 * Wakes the Bot with the call's Approval Trigger, under its Conversation's row lock: once, since
 * its id comes from the review. A Bot deleted meanwhile wakes no one. Returns whether it woke.
 */
async function wakeWith(
  deps: BotSdkContext,
  tx: Transaction,
  call: StoredCall,
  result: unknown,
): Promise<boolean> {
  await lockConversation(tx, call.conversationId);
  const [kept] = await tx.select({ id: bot.id }).from(bot).where(eq(bot.id, call.botId));
  if (!kept) return false;
  const id = approvalTriggerId(call.reviewId);
  const [seen] = await tx
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(eq(botTrigger.id, id));
  if (seen) return false;
  await receive(deps, tx, {
    id,
    conversationId: call.conversationId,
    source: "approval",
    channel: "web",
    text: approvalTriggerText(
      { id: call.reviewId, tool: call.tool, summary: call.summary },
      { result },
    ),
    receivedAt: deps.clock(),
  });
  return true;
}
