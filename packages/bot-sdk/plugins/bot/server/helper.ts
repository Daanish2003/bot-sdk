import { type ModelMessage, toolDefinition } from "@tanstack/ai";
import { and, asc, count, eq, inArray, isNotNull, like } from "drizzle-orm";
import { z } from "zod";

import { bot, botHelper, botTrigger } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { defineJob, PermanentJobError } from "../../runner/server/jobs/define";
import { loadHistory } from "../../runner/server/jobs/history";
import { createWorkflow, type WorkflowContext } from "../../runner/server/workflow/engine";
import {
  ComputerOperationError,
  ComputerUnavailableError,
  maxScreens,
} from "../../computer/server/plugin";
import { BrowserSession, browserTools } from "./browser-tools";
import { computerOf } from "./computer-tools";
import { type LoopKit, type LoopResult, runLoop } from "./loop";
import { lockConversation, receive } from "./router";
import { hintChanged } from "./turn";

/** The runner job that runs one Helper (#565). */
export const botHelperJobName = "bot.helper";

/** The Bot's tool that hands a task to a Helper (#566). */
export const startHelperToolName = "start_helper";

/** The most Steps a Helper may take; one more ends it `error`. */
export const helperStepLimit = 50;

/** The longest a Helper may run; past it, it ends `error`. */
export const helperTimeLimitMs = 30 * 60_000;

/** The longest report a Helper hands back, in characters. */
export const helperReportLimit = 2_000;

/** How many General Helpers a Bot may have at once. */
export const generalHelperLimit = 3;

export const tooManyGeneralHelpersError =
  "3 General Helpers are already running; check on or stop one first.";

export const computerUseHelperTakenError =
  "A Computer-use Helper is already running; check on or stop it first.";

export const screensInUseError = "All 4 Screens are in use; try again later.";

export const helperQuotaSpentError = "Your spending limit is reached; tell the user.";

/** The opening and report rules every Helper's prompt starts with (#573). */
const helperPromptOpening =
  "You are a Helper doing one task for a Bot. No one reads your text except the Bot, and only your " +
  "final reply, which is your report: keep it short (under 2,000 characters), results first, and " +
  "put anything long in a file and give its path.";

/** The General Helper's system prompt (#573). */
export const generalHelperPrompt =
  `${helperPromptOpening} Work cheapest first: what you know and your ` +
  "files, then `web_search`. You have no browser; if the task needs a website search can't reach, " +
  "say so in your report. If a tool is broken, stop and say so in your report instead of working " +
  "around it.";

/**
 * The Computer-use Helper's system prompt (#573). Its `desktop` and `ask_user` sentences come with
 * those tools.
 */
export const computerUseHelperPrompt =
  `${helperPromptOpening} Use the browser tools first: read the page with \`browser_snapshot\` ` +
  "and act by ref.";

/** The reports of a Helper that ended before it finished. */
export const helperEndings = {
  stepLimit: `The Helper used all ${helperStepLimit} Steps before it finished.`,
  timedOut: "The Helper ran out of time (30 minutes) before it finished.",
  crashed: "The Helper crashed and could not carry on.",
  failed: (error: string) => `The Helper failed: ${error}`,
  empty: "The Helper finished with no report.",
};

const startHelperDefinition = toolDefinition({
  name: startHelperToolName,
  description:
    "Hand a complete task to a Helper, which works on it in the background while you keep talking " +
    "to the user. A general Helper has the shell and files; a computer_use Helper has its own " +
    "Screen with a browser, for websites. It sees only the task, " +
    "nothing of this conversation, so write the task so it stands alone: the goal, everything it " +
    "needs to know, and what to report. Its short report comes back to you later; tell the user " +
    "what matters in it. It returns the Helper's id.",
  inputSchema: z.object({
    type: z.enum(["general", "computer_use"]).meta({
      description: "general: the shell and files. computer_use: a browser on its own Screen.",
    }),
    task: z.string().trim().min(1, "task must not be empty").meta({
      description: "The complete task, written so it stands alone.",
    }),
  }),
});

/** A Helper job's idempotency key, by which it is cancelled. */
const helperJobKey = (helperId: string) => `helper:${helperId}`;

/** What `start_helper` needs of the Turn that calls it. */
type HelperStarter = { id: string; botId: string; userId: string; model: string };

/**
 * The `start_helper` tool of `turn`'s loop: in one Checkpoint, a `running` Helper row and its
 * `bot.helper` job, so the Helper starts once. The Turn carries on; the Helper reports back as a
 * `helper` Trigger. Refused, with a next step, once the Quota is spent, the Bot already has
 * `generalHelperLimit` General Helpers or a Computer-use Helper, or every Screen is held. A
 * Computer-use Helper holds the lowest Screen slot no running or waiting Helper of the user holds.
 */
export function startHelperTool(
  deps: BotSdkContext,
  turn: HelperStarter,
  liveActivity: LoopKit["liveActivity"],
) {
  return startHelperDefinition.server(async ({ type, task }, context) => {
    const result = await liveActivity(startHelperToolName, context?.toolCallId, async (tx) => {
      // Checked here only, so a resumed Helper is never refused.
      const call = await deps.plugin("models").resolveModelCall(turn.userId, turn.model);
      if (call && !(await call.meter.mayRun()).ok) return { error: helperQuotaSpentError };
      // The Bot's row lock, so two calls can't both take the last place; a Screen is the user's,
      // so a Computer-use Helper locks all their Bots, in id order.
      await tx
        .select({ id: bot.id })
        .from(bot)
        .where(type === "general" ? eq(bot.id, turn.botId) : eq(bot.userId, turn.userId))
        .orderBy(asc(bot.id))
        .for("no key update");
      const [live] = await tx
        .select({ count: count() })
        .from(botHelper)
        .where(
          and(
            eq(botHelper.botId, turn.botId),
            eq(botHelper.type, type),
            inArray(botHelper.status, ["running", "waiting"]),
          ),
        );
      const limit = type === "general" ? generalHelperLimit : 1;
      if ((live?.count ?? 0) >= limit) {
        return {
          error: type === "general" ? tooManyGeneralHelpersError : computerUseHelperTakenError,
        };
      }
      let screen: number | null = null;
      if (type === "computer_use") {
        screen = await freeScreen(tx, turn.userId);
        if (screen === null) return { error: screensInUseError };
      }
      const helperId = uuidv7();
      const jobId = await deps
        .plugin("runner")
        .enqueueIn(tx, botHelperJobName, { helperId }, { idempotencyKey: helperJobKey(helperId) });
      await tx.insert(botHelper).values({
        id: helperId,
        botId: turn.botId,
        type,
        task,
        status: "running",
        startedByTurnId: turn.id,
        jobId,
        screen,
        startedAt: deps.clock(),
      });
      return { helperId, status: "running" as const };
    });
    if ("helperId" in result) deps.plugin("runner").wake();
    return result;
  });
}

/** The lowest Screen slot that no running or waiting Helper of the user holds, or null. */
async function freeScreen(tx: Transaction, userId: string): Promise<number | null> {
  const held = await tx
    .select({ screen: botHelper.screen })
    .from(botHelper)
    .innerJoin(bot, eq(bot.id, botHelper.botId))
    .where(
      and(
        eq(bot.userId, userId),
        inArray(botHelper.status, ["running", "waiting"]),
        isNotNull(botHelper.screen),
      ),
    );
  const taken = new Set(held.map((row) => row.screen));
  for (let slot = 1; slot <= maxScreens; slot += 1) if (!taken.has(slot)) return slot;
  return null;
}

/** The runner job of one Helper, keyed by `helper:<id>` (ADR 0011, the #565 amendment). */
export const botHelperJob = defineJob({
  name: botHelperJobName,
  payload: z.object({ helperId: z.uuid() }),
  run: ({ helperId }, ctx) => runHelperJob(ctx.deps, helperId, ctx),
  onFailed: ({ helperId }, _error, deps) => endLostHelper(deps, helperId),
});

/** What a Helper's job reads once per attempt. */
type HelperFacts = {
  id: string;
  botId: string;
  userId: string;
  model: string;
  type: "general" | "computer_use";
  task: string;
  status: string;
  startedAt: Date;
  jobId: string | null;
  /** The Screen slot a Computer-use Helper holds. */
  screen: number | null;
};

async function helperFacts(
  db: Database | Transaction,
  helperId: string,
): Promise<HelperFacts | undefined> {
  const [row] = await db
    .select({
      id: botHelper.id,
      botId: botHelper.botId,
      type: botHelper.type,
      task: botHelper.task,
      status: botHelper.status,
      startedAt: botHelper.startedAt,
      jobId: botHelper.jobId,
      screen: botHelper.screen,
      userId: bot.userId,
      model: bot.model,
    })
    .from(botHelper)
    .innerJoin(bot, eq(bot.id, botHelper.botId))
    .where(eq(botHelper.id, helperId));
  return row;
}

/**
 * One attempt of a Helper's job: it replays the Helper's recorded calls, makes the rest for real,
 * then ends the Helper and hands the Router its report in its last Checkpoint. An attempt that lost
 * its job writes nothing more: the next attempt resumes it.
 */
async function runHelperJob(
  deps: BotSdkContext,
  helperId: string,
  ctx: WorkflowContext<Transaction> & { signal: AbortSignal },
) {
  const helper = await helperFacts(deps.db, helperId);
  if (!helper) throw new PermanentJobError(`Helper ${helperId} no longer exists`);
  if (helper.status !== "running") return;
  const session =
    helper.screen === null ? undefined : new BrowserSession(helper.screen, helper.botId);
  let played: LoopResult;
  try {
    played = await playHelper(deps, helper, ctx, ctx.signal, session);
  } finally {
    await session?.close();
  }
  ctx.signal.throwIfAborted();
  // A thrown activity recorded nothing: the job retries it.
  if (played.failure !== undefined) throw played.failure;
  // Before the end frees its slot, so it never closes the Screen of the next Helper on it.
  await closeScreen(deps, helper);
  const ended = await ctx.activity("end_helper", (tx) =>
    endHelper(deps, tx, helper, endingOf(played), played),
  );
  if (ended) await afterReport(deps, ended.conversationId);
}

/** Closes an ending Helper's Screen, best-effort: its Chrome profile stays. */
async function closeScreen(
  deps: BotSdkContext,
  helper: Pick<HelperFacts, "id" | "userId" | "screen">,
) {
  if (helper.screen === null) return;
  await computerOf(deps, helper.userId)
    .closeScreen(helper.screen)
    .catch((caught) =>
      deps.logger.error(`Closing the Screen of Helper ${helper.id} failed`, caught),
    );
}

/** The Helper's model input: its task, as the only user turn. */
const helperInput = (helper: Pick<HelperFacts, "task">): ModelMessage[] => [
  { role: "user", content: helper.task },
];

/**
 * The Helper's loop: its own context on its Bot's Model, with the Computer's tools, or a
 * Computer-use Helper's Browser tools on `session`, whose Screen it opens before its first Step
 * when it runs live.
 */
function playHelper(
  deps: BotSdkContext,
  helper: HelperFacts,
  ctx: WorkflowContext<Transaction>,
  attempt?: AbortSignal,
  session?: BrowserSession,
): Promise<LoopResult> {
  return runLoop(deps, ctx, {
    owner: helper,
    usageKind: "helper",
    input: helperInput(helper),
    startedAt: helper.startedAt,
    stepLimit: helperStepLimit,
    timeLimitMs: helperTimeLimitMs,
    attempt,
    // The Bot isn't told by its Helper's results: its own next Computer call tells it.
    tellsBot: false,
    setup: async (kit) => {
      if (!session) return { systemPrompts: [generalHelperPrompt], tools: kit.computerTools };
      // A Screen that won't open now is opened again by the first Browser tool, which tells the
      // Helper why it can't; anything else ends the Helper `error`.
      const unlessComputerFailed = (caught: unknown) => {
        if (caught instanceof ComputerUnavailableError) return false;
        if (caught instanceof ComputerOperationError) return false;
        throw caught;
      };
      // Opened afresh on the Bot's profile once per Helper, so a Screen another Helper left on
      // this slot is never driven; a later attempt connects to it as it is.
      await ctx.activity("open_screen", () =>
        computerOf(deps, helper.userId)
          .openScreen(session.slot, helper.botId)
          .then(() => true, unlessComputerFailed),
      );
      if (attempt) {
        await session.open(computerOf(deps, helper.userId)).catch(unlessComputerFailed);
      }
      return {
        systemPrompts: [computerUseHelperPrompt],
        tools: browserTools(session, helper.botId, kit.computerCall),
      };
    },
  });
}

/** How a Helper's played loop ends: its status and its report. */
function endingOf(played: LoopResult): { status: "complete" | "error"; report: string } {
  if (played.timedOut) return { status: "error", report: helperEndings.timedOut };
  if (played.error !== undefined) {
    return { status: "error", report: helperEndings.failed(played.error) };
  }
  if (played.stepLimit) return { status: "error", report: helperEndings.stepLimit };
  if (!played.finished) return { status: "error", report: helperEndings.crashed };
  return { status: "complete", report: capReport(finalText(played.transcript)) };
}

/** The plain text of the last Step, when it called no tool. */
function finalText(transcript: readonly ModelMessage[]): string {
  const last = transcript.at(-1);
  if (last?.role !== "assistant" || last.toolCalls?.length) return "";
  const content =
    typeof last.content === "string"
      ? last.content
      : (last.content ?? []).map((part) => (part.type === "text" ? part.content : "")).join("");
  return content.trim();
}

function capReport(report: string): string {
  if (!report) return helperEndings.empty;
  if (report.length <= helperReportLimit) return report;
  return `${report.slice(0, helperReportLimit - 1)}…`;
}

/** The task's first line, short enough for a header. */
function gistOf(task: string): string {
  const line = task.trim().split("\n")[0]!.trim();
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
}

/**
 * Ends a `running` Helper as `ending` says and hands the Router its report as a `helper` / `helper`
 * Trigger, under its Conversation's row lock. Its id is `helper:<id>:<n>`, the Helper's n-th report.
 * A Helper that already ended stays as it is and sends nothing, so a retried finish sends one
 * Trigger. Returns the Conversation that got it, or `null`.
 */
async function endHelper(
  deps: BotSdkContext,
  tx: Transaction,
  helper: Pick<HelperFacts, "id" | "botId" | "type" | "task">,
  ending: { status: "complete" | "error"; report: string },
  played: Pick<LoopResult, "transcript" | "usage">,
): Promise<{ conversationId: string } | null> {
  const [owner] = await tx
    .select({ conversationId: bot.conversationId })
    .from(bot)
    .where(eq(bot.id, helper.botId));
  if (!owner) return null;
  await lockConversation(tx, owner.conversationId);
  const now = deps.clock();
  const rows = await tx
    .update(botHelper)
    .set({
      ...ending,
      transcript: [...helperInput(helper), ...played.transcript],
      usage: played.usage,
      endedAt: now,
    })
    .where(and(eq(botHelper.id, helper.id), eq(botHelper.status, "running")))
    .returning({ id: botHelper.id });
  if (rows.length === 0) return null;
  const [reports] = await tx
    .select({ count: count() })
    .from(botTrigger)
    .where(like(botTrigger.id, `helper:${helper.id}:%`));
  const kind = helper.type === "general" ? "General Helper" : "Computer-use Helper";
  await receive(deps, tx, {
    id: `helper:${helper.id}:${(reports?.count ?? 0) + 1}`,
    conversationId: owner.conversationId,
    source: "helper",
    channel: "helper",
    text: `${kind} finished: ${gistOf(helper.task)}, status ${ending.status}\n\n${ending.report}`,
    receivedAt: now,
  });
  return { conversationId: owner.conversationId };
}

/** Once a report's Trigger has committed: the Turn it started runs, and followers re-read. */
async function afterReport(deps: BotSdkContext, conversationId: string) {
  deps.plugin("runner").wake();
  await hintChanged(deps, conversationId);
}

/**
 * The job's `onFailed`, once the runner has given up on it: ends a Helper still `running` `error`
 * with what its recorded Checkpoints hold, and it still reports back.
 */
async function endLostHelper(deps: BotSdkContext, helperId: string) {
  const helper = await helperFacts(deps.db, helperId);
  if (helper?.status !== "running") return;
  let played: Pick<LoopResult, "transcript" | "usage"> = { transcript: [], usage: null };
  try {
    played = await replayedHelper(deps, helper);
  } catch (caught) {
    // The Helper still ends and reports, so it never reads `running` forever.
    deps.logger.error(`Replaying the Checkpoints of Helper ${helperId} failed`, caught);
  }
  await closeScreen(deps, helper);
  const ended = await deps.db.transaction((tx) =>
    endHelper(deps, tx, helper, { status: "error", report: helperEndings.crashed }, played),
  );
  if (ended) await afterReport(deps, ended.conversationId);
}

/** What a Helper whose job has ended did: its recorded calls replay, and nothing more runs. */
async function replayedHelper(deps: BotSdkContext, helper: HelperFacts) {
  const history = helper.jobId ? await loadHistory(deps.db, helper.jobId) : [];
  const workflow = createWorkflow<Transaction>({
    history,
    store: { save: async () => false, saveWith: async () => ({ saved: false }) },
    now: deps.clock,
    signal: AbortSignal.abort(new Error("The Helper's job has ended")),
  });
  const session =
    helper.screen === null ? undefined : new BrowserSession(helper.screen, helper.botId);
  return playHelper(deps, helper, workflow.context, undefined, session);
}

/** Whether one of the user's Helpers is running, so it may use the Computer: a busy check. */
export async function hasRunningHelper(db: Database, userId: string): Promise<boolean> {
  const [running] = await db
    .select({ id: botHelper.id })
    .from(botHelper)
    .innerJoin(bot, eq(bot.id, botHelper.botId))
    .where(and(eq(bot.userId, userId), eq(botHelper.status, "running")))
    .limit(1);
  return running !== undefined;
}

/** Cancels the queued or running jobs of the user's Helpers, as the user is deleted. */
export async function cancelUserHelpers(
  deps: BotSdkContext,
  tx: Transaction,
  userId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: botHelper.id })
    .from(botHelper)
    .innerJoin(bot, eq(bot.id, botHelper.botId))
    .where(and(eq(bot.userId, userId), eq(botHelper.status, "running")));
  const runner = deps.plugin("runner");
  for (const { id } of rows) await runner.cancelIn(tx, helperJobKey(id));
}
