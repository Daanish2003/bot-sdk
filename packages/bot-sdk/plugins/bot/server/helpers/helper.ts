import { type ModelMessage, firstSentence, toolDefinition } from "@tanstack/ai";
import { and, asc, count, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import {
  bot,
  botDemonstration,
  botHelper,
  botHelperMessage,
} from "../../../../core/server/storage";
import type { Database } from "../../../../core/server/storage";
import { hasConnectorFeature } from "../../../../core/server/feature";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../../../core/server/plugin";
import { canUseComputer, providerOf } from "../../../models/shared/models";
import type { MessageUsage } from "../../../models/shared/usage";
import {
  defineCoreJob,
  PermanentJobError,
  loadHistory,
  createWorkflow,
  type WorkflowContext,
} from "../../../runner/server/internal";

import {
  ComputerOperationError,
  ComputerUnavailableError,
  maxScreens,
} from "../../../computer/server/internal";
import { liveDemonstrationStates } from "../../shared/demonstration";
import { BrowserSession, browserTools } from "./browser-tools";
import { storeScreenshot, recordBotChange, hintChanged } from "../conversation";
import {
  computerOf,
  type LoopKit,
  type LoopResult,
  runLoop,
  totalUsage,
  webSearchTool,
} from "../agent-loop";
import { computerUseTool } from "./computer-use-tool";

import {
  type TodoItem,
  featureTools,
  featureTurnOf,
  describeToolName,
  runToolName,
  toolSearchTools,
} from "../context";
import { closeWaitingReviews } from "../safety";
import { lockConversation, receive } from "../triggers";

import {
  answeredTranscript,
  askUserTool,
  handOff,
  openCardReason,
  resumeAnswer,
  stepsIn,
} from "./hand-off";

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

export const computerUseModelError =
  "This Bot's Model can't run a Computer-use Helper; tell the user to switch the Bot to a direct Anthropic or OpenAI Model.";

export const computerUseOnPlanError =
  "A linked ChatGPT plan can't run a Computer-use Helper; tell the user to switch the Bot to a Model on an OpenAI or Anthropic API key.";

export const screensInUseError = "All 4 Screens are in use; try again later.";

export const demonstrationHoldsScreenError =
  "The user is showing you a task on your Screen; wait until they finish it from its card.";

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

/** What opens the list of Connector tools a General Helper may use (spec #801). */
const connectorsPrompt =
  `The user's connectors are deferred tools: call ${describeToolName} with the name first, then ` +
  `${runToolName}. Each call is checked against your task.`;

/** The Computer-use Helper's system prompt (#573). */
export const computerUseHelperPrompt =
  `${helperPromptOpening} Use the browser tools first: read the page with \`browser_snapshot\` ` +
  "and act by ref. Use `computer` only for what the browser can't reach, such as desktop apps and " +
  "system dialogs. At a login, verification code, captcha or payment, stop and call `ask_user` " +
  "with where you are and what the user needs to do; never type a password or a code yourself.";

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
    "to the user. A general Helper has the shell, files and web search; a computer_use Helper has " +
    "its own Screen with a browser, for websites. It sees only the task, " +
    "nothing of this conversation, so write the task so it stands alone: the goal, everything it " +
    "needs to know, and what to report. Its short report comes back to you later; tell the user " +
    "what matters in it. It returns the Helper's id.",
  inputSchema: z.object({
    type: z.enum(["general", "computer_use"]).meta({
      description:
        "general: the shell, files and web search. computer_use: a browser on its own Screen.",
    }),
    task: z.string().trim().min(1, "task must not be empty").meta({
      description: "The complete task, written so it stands alone.",
    }),
  }),
});

/** A Helper job's idempotency key, by which it is cancelled. A resumed Helper's job takes it too. */
export const helperJobKey = (helperId: string) => `helper:${helperId}`;

/** What `start_helper` needs of the Turn that calls it. */
type HelperStarter = {
  id: string;
  botId: string;
  conversationId: string;
  userId: string;
  model: string;
};

/**
 * The `start_helper` tool of `turn`'s loop: in one Checkpoint, a `running` Helper row and its
 * `bot.helper` job, so the Helper starts once. The Turn carries on; the Helper reports back as a
 * `helper` Trigger. Refused, with a next step, once the Quota is spent, the Bot already has
 * `generalHelperLimit` General Helpers or a Computer-use Helper, a Demonstration holds the Bot's
 * Screen (spec #713), or every Screen is held. A Computer-use Helper holds the lowest Screen slot
 * that nothing of the user's holds (`freeScreen`).
 */
export function startHelperTool(
  deps: BotSdkContext,
  turn: HelperStarter,
  liveActivity: LoopKit["liveActivity"],
) {
  return startHelperDefinition.server(async ({ type, task }, context) => {
    const result = await liveActivity(startHelperToolName, context?.toolCallId, async (tx) => {
      if (type === "computer_use" && !canUseComputer(providerOf(turn.model))) {
        return { error: computerUseModelError };
      }
      // Checked here only, so a resumed Helper is never refused.
      const call = await deps.models.resolveModelCall(turn.userId, turn.model);
      // The plan's endpoint rejects the native computer tool.
      if (type === "computer_use" && call?.linked === "plan") {
        return { error: computerUseOnPlanError };
      }
      if (call && !(await call.meter.mayRun()).ok) return { error: helperQuotaSpentError };
      // The Conversation's row lock first, as in every write that changes the Bot thread.
      await lockConversation(tx, turn.conversationId);
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
        if (await hasLiveDemonstration(tx, { botId: turn.botId })) {
          return { error: demonstrationHoldsScreenError };
        }
        screen = await freeScreen(tx, turn.userId);
        if (screen === null) return { error: screensInUseError };
        // Waits out a close of the Helper that had it, so the close never lands on this one.
        await lockScreen(tx, turn.userId, screen);
      }
      const helperId = uuidv7();
      const startedAt = deps.clock();
      const jobId = await deps.runner.enqueueIn(
        tx,
        botHelperJobName,
        { helperId },
        { idempotencyKey: helperJobKey(helperId) },
      );
      await tx.insert(botHelper).values({
        id: helperId,
        botId: turn.botId,
        type,
        task,
        status: "running",
        startedByTurnId: turn.id,
        jobId,
        screen,
        startedAt,
      });
      await recordBotChange(tx, turn, "helper", helperId, startedAt);
      return { helperId, status: "running" as const };
    });
    if ("helperId" in result) {
      deps.runner.wake();
      await hintChanged(deps, turn.conversationId);
    }
    return result;
  });
}

/**
 * The lowest Screen slot that no running or waiting Helper of the user holds, nor a live
 * Demonstration of theirs (spec #713), or null.
 */
export async function freeScreen(tx: Transaction, userId: string): Promise<number | null> {
  const helpers = await tx
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
  const demonstrations = await tx
    .select({ screen: botDemonstration.screen })
    .from(botDemonstration)
    .where(
      and(
        eq(botDemonstration.userId, userId),
        inArray(botDemonstration.state, [...liveDemonstrationStates]),
      ),
    );
  const taken = new Set([...helpers, ...demonstrations].map((row) => row.screen));
  for (let slot = 1; slot <= maxScreens; slot += 1) if (!taken.has(slot)) return slot;
  return null;
}

/**
 * The user's Screen `slot`'s lock, until `tx` ends: `start_helper` and `watch_user` take it as they
 * hand the slot out, and `closeScreen` holds it while it closes the Screen.
 */
export async function lockScreen(tx: Transaction, userId: string, slot: number) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`screen:${userId}:${slot}`}, 0))`,
  );
}

/** The Helpers and the Demonstration captures run for long: four at once, beside the rest (#602). */
export const helperJobBudget = { budget: "helper", concurrency: 4 } as const;

/**
 * The runner job of one Helper, keyed by `helper:<id>` (ADR 0011, the #565 amendment). The job of a
 * Helper the user's Done resumed has `waitedSince`, when it began to wait.
 */
export const botHelperJob = defineCoreJob({
  name: botHelperJobName,
  ...helperJobBudget,
  payload: z.object({ helperId: z.uuid(), waitedSince: z.iso.datetime().optional() }),
  run: ({ helperId, waitedSince }, ctx) => runHelperJob(ctx.deps, helperId, ctx, waitedSince),
  onFailed: ({ helperId, waitedSince }, _error, { deps }) =>
    endLostHelper(deps, helperId, waitedSince),
});

/** What a Helper's job reads once per attempt. */
type HelperFacts = {
  id: string;
  botId: string;
  userId: string;
  model: string;
  /** Its Bot's Conversation, where its Approval requests show. */
  conversationId: string;
  type: "general" | "computer_use";
  task: string;
  /** The Turn whose start_helper call started it. */
  startedByTurnId: string;
  status: string;
  startedAt: Date;
  jobId: string | null;
  /** The Screen slot a Computer-use Helper holds. */
  screen: number | null;
  /** Its context as saved when it last waited for the user, or null. */
  transcript: ModelMessage[] | null;
  /** What its model calls billed before it last waited, or null. */
  usage: MessageUsage | null;
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
      startedByTurnId: botHelper.startedByTurnId,
      status: botHelper.status,
      startedAt: botHelper.startedAt,
      jobId: botHelper.jobId,
      screen: botHelper.screen,
      transcript: botHelper.transcript,
      usage: botHelper.usage,
      userId: bot.userId,
      model: bot.model,
      conversationId: bot.conversationId,
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
  waitedSince?: string,
) {
  const helper = await helperFacts(deps.db, helperId);
  if (!helper) throw new PermanentJobError(`Helper ${helperId} no longer exists`);
  if (helper.status !== "running") return;
  const session =
    helper.screen === null ? undefined : new BrowserSession(helper.screen, helper.botId);
  let played: PlayedHelper;
  try {
    played = await playHelper(deps, helper, ctx, waitedSince, ctx.signal, session);
  } finally {
    await session?.close();
  }
  ctx.signal.throwIfAborted();
  // A thrown activity recorded nothing: the job retries it.
  if (played.failure !== undefined) throw played.failure;
  // A hand-off ends the job, keeping the Screen open for the user; Done starts a new one (#568).
  const reason = played.askedUser;
  if (reason !== undefined) {
    const handed = await ctx.step("hand_off", (tx) =>
      handOff(deps, tx, helper, reason, {
        transcript: [...played.input, ...played.transcript],
        usage: usageSoFar(helper, played),
      }),
    );
    if (handed) await hintChanged(deps, handed.conversationId);
    return;
  }
  // Before the end frees its slot, so it never closes the Screen of the next Helper on it.
  await closeScreen(deps, helper);
  const ended = await ctx.step("end_helper", (tx) =>
    endHelper(deps, tx, helper, endingOf(played), played),
  );
  if (ended) await afterReport(deps, ended.conversationId);
}

/**
 * Closes the Screen of an ending or stopped Helper, or of an ended Demonstration (spec #713, whose
 * id is `helper.id`), best-effort: its Chrome profile stays. Under the slot's lock, and only while
 * nothing else of the user's holds the slot, so it never closes the Screen of whatever took the
 * slot next.
 */
export async function closeScreen(
  deps: BotSdkContext,
  helper: Pick<HelperFacts, "id" | "userId" | "screen">,
) {
  const slot = helper.screen;
  if (slot === null) return;
  await deps.db
    .transaction(async (tx) => {
      await lockScreen(tx, helper.userId, slot);
      const [next] = await tx
        .select({ id: botHelper.id })
        .from(botHelper)
        .innerJoin(bot, eq(bot.id, botHelper.botId))
        .where(
          and(
            eq(bot.userId, helper.userId),
            eq(botHelper.screen, slot),
            inArray(botHelper.status, ["running", "waiting"]),
            ne(botHelper.id, helper.id),
          ),
        )
        .limit(1);
      if (next) return;
      const [demonstration] = await tx
        .select({ id: botDemonstration.id })
        .from(botDemonstration)
        .where(
          and(
            eq(botDemonstration.userId, helper.userId),
            eq(botDemonstration.screen, slot),
            inArray(botDemonstration.state, [...liveDemonstrationStates]),
            ne(botDemonstration.id, helper.id),
          ),
        )
        .limit(1);
      if (demonstration) return;
      await computerOf(deps, helper.userId).closeScreen(slot);
    })
    .catch((caught) => deps.logger.error(`Closing the Screen of ${helper.id} failed`, caught));
}

/** The Helper's model input: its task, as the only user turn. */
const helperInput = (helper: Pick<HelperFacts, "task">): ModelMessage[] => [
  { role: "user", content: helper.task },
];

/** What its model calls billed so far: before it last waited, and in this job. */
function usageSoFar(
  helper: Pick<HelperFacts, "usage">,
  played: Pick<LoopResult, "usage">,
): MessageUsage | null {
  const calls = [helper.usage, played.usage].filter((usage) => usage !== null);
  return calls.length > 0 ? totalUsage(calls) : null;
}

/** A played Helper loop, with the model input it started from and the reason it asked the user. */
type PlayedHelper = LoopResult & { input: ModelMessage[]; askedUser?: string };

/**
 * The Helper's loop: its own context on its Bot's Model, with the Computer's tools, or a
 * Computer-use Helper's Browser tools and `ask_user` on `session`, whose Screen it opens before its
 * first Step when it runs live. A Helper the user's Done resumed carries on from its saved
 * transcript, with its Screen as it was and its `ask_user` call answered in its first Checkpoint,
 * and its Steps so far count against its limit.
 */
async function playHelper(
  deps: BotSdkContext,
  helper: HelperFacts,
  ctx: WorkflowContext<Transaction>,
  waitedSince?: string,
  attempt?: AbortSignal,
  session?: BrowserSession,
): Promise<PlayedHelper> {
  const saved = helper.transcript;
  const input = saved
    ? answeredTranscript(
        saved,
        await ctx.step("resume", () =>
          resumeAnswer(deps, helper, waitedSince ? new Date(waitedSince) : helper.startedAt),
        ),
      )
    : helperInput(helper);
  let askedUser: string | undefined;
  // A General Helper's Connector tool clients stay open for its loop, and close when it ends.
  const connections = new AbortController();
  // Whether an `inbox` activity ran live since the last hint.
  let delivered = false;
  const played = await runLoop(deps, ctx, {
    owner: helper,
    usageKind: "helper",
    sourceId: helper.id,
    input,
    startedAt: helper.startedAt,
    stepLimit: helperStepLimit - stepsIn(input),
    timeLimitMs: helperTimeLimitMs,
    attempt,
    // The Bot isn't told by its Helper's results: its own next Computer call tells it.
    tellsBot: false,
    // Before each Step, its progress so far is a change to the Bot thread, then its inbox is read.
    inbox: async (tx) => {
      await recordBotChange(tx, helper, "helper", helper.id, deps.clock());
      delivered = true;
      return deliverMessages(deps, tx, helper.id);
    },
    // Only after a live inbox: a replayed one changed nothing.
    afterInbox: async () => {
      if (!delivered) return;
      delivered = false;
      await hintChanged(deps, helper.conversationId);
    },
    // Its risky calls get Auto-review, with its task as the Bot's words (spec #691).
    review: {
      helperId: helper.id,
      conversationId: helper.conversationId,
      task: helper.task,
      startedByTurnId: helper.startedByTurnId,
    },
    setup: async (kit) => {
      if (!session) {
        const own = [...kit.computerTools, webSearchTool(deps, helper.userId, kit.liveRequest)];
        // The owner's Connector tools, listed by name and reached through a small tool search; a
        // Computer-use Helper has none (lecture slide 27).
        // Only the Connector tools: a Helper gets no other feature's.
        const connectors = hasConnectorFeature(deps)
          ? await featureTools(
              deps,
              featureTurnOf(helper),
              kit.liveRequest,
              new Set([describeToolName, runToolName, ...own.map((tool) => tool.name)]),
              [],
              {
                signal: connections.signal,
                record: (featureId, list) => ctx.step(`${featureId}:tools`, list),
                computerCall: kit.computerCall,
              },
              { connectorsOnly: true },
            )
          : undefined;
        if (!connectors || connectors.tools.length === 0) {
          return { systemPrompts: [generalHelperPrompt], tools: own };
        }
        const listed = connectors.tools.map(
          (tool) => `${tool.name}: ${firstSentence(tool.description)}`,
        );
        return {
          systemPrompts: [`${generalHelperPrompt} ${connectorsPrompt}\n${listed.join("\n")}`],
          tools: [...own, ...toolSearchTools(connectors.tools, connectors.missing)],
        };
      }
      // A Screen that won't open now is opened again by the first Browser tool, which tells the
      // Helper why it can't; anything else ends the Helper `error`.
      const unlessComputerFailed = (caught: unknown) => {
        if (caught instanceof ComputerUnavailableError) return false;
        if (caught instanceof ComputerOperationError) return false;
        throw caught;
      };
      // Opened afresh on the Bot's profile once per Helper, so a Screen another Helper left on
      // this slot is never driven; a later attempt, or a resumed Helper, connects to it as it is.
      if (!saved) {
        await ctx.step("open_screen", () =>
          computerOf(deps, helper.userId)
            .openScreen(session.slot, helper.botId)
            .then(() => true, unlessComputerFailed),
        );
      }
      if (attempt) {
        await session.open(computerOf(deps, helper.userId)).catch(unlessComputerFailed);
      }
      return {
        systemPrompts: [computerUseHelperPrompt],
        tools: [
          ...browserTools(session, helper.botId, kit.computerCall),
          computerUseTool(
            helper.id,
            session.slot,
            kit.computerCall,
            async () => {
              const model = await deps.models.resolveModel(helper.userId, helper.model);
              return model?.images ?? false;
            },
            (png) => storeScreenshot(deps, helper.id, png),
          ),
          askUserTool((reason) => (askedUser ??= reason)),
        ],
        ended: () => askedUser !== undefined,
      };
    },
  }).finally(() => connections.abort());
  return { ...played, input, askedUser };
}

/** How a Message from the Bot opens in the Helper's model input (#566). */
export const helperMessagePrefix = "Message from your Bot: ";

/**
 * The Bot's Messages to Helper `helperId` that it hasn't read, oldest first, as its inbox reads
 * them before a model call: each is marked delivered in the inbox's Checkpoint, so it arrives once.
 */
async function deliverMessages(deps: BotSdkContext, tx: Transaction, helperId: string) {
  const rows = await tx
    .update(botHelperMessage)
    .set({ deliveredAt: deps.clock() })
    .where(and(eq(botHelperMessage.helperId, helperId), isNull(botHelperMessage.deliveredAt)))
    .returning({
      id: botHelperMessage.id,
      text: botHelperMessage.text,
      createdAt: botHelperMessage.createdAt,
    });
  // uuidv7 ids sort in the order they were sent.
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows.map((row) => `${helperMessagePrefix}${row.text}`);
}

/** The Bot's to-do list (#567): its `running` and `waiting` Helpers, oldest first. */
export async function todoList(db: Database | Transaction, botId: string): Promise<TodoItem[]> {
  const rows = await db
    .select({
      id: botHelper.id,
      type: botHelper.type,
      status: botHelper.status,
      task: botHelper.task,
      startedAt: botHelper.startedAt,
    })
    .from(botHelper)
    .where(and(eq(botHelper.botId, botId), inArray(botHelper.status, ["running", "waiting"])))
    .orderBy(asc(botHelper.startedAt), asc(botHelper.id));
  return Promise.all(
    rows.map(async (row) => {
      const reason = row.status === "waiting" ? await openCardReason(db, row.id) : undefined;
      return {
        id: row.id,
        type: row.type,
        status: row.status as TodoItem["status"],
        gist: gistOf(row.task),
        startedAt: row.startedAt.toISOString(),
        ...(reason !== undefined && { reason }),
      };
    }),
  );
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
export function gistOf(task: string): string {
  const line = task.trim().split("\n")[0]!.trim();
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
}

/**
 * Ends a `running` Helper as `ending` says and hands the Router its report as a `helper` / `helper`
 * Trigger, under its Conversation's row lock. Its id is `helper:<id>`: a Helper ends once.
 * A Helper that already ended stays as it is and sends nothing, so a retried finish sends one
 * Trigger. Returns the Conversation that got it, or `null`.
 */
async function endHelper(
  deps: BotSdkContext,
  tx: Transaction,
  helper: Pick<HelperFacts, "id" | "botId" | "type" | "task" | "usage">,
  ending: { status: "complete" | "error"; report: string },
  played: Pick<PlayedHelper, "input" | "transcript" | "usage">,
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
      transcript: [...played.input, ...played.transcript],
      usage: usageSoFar(helper, played),
      endedAt: now,
    })
    .where(and(eq(botHelper.id, helper.id), eq(botHelper.status, "running")))
    .returning({ id: botHelper.id });
  if (rows.length === 0) return null;
  await recordBotChange(tx, owner, "helper", helper.id, now);
  // A Helper cut off mid-wait (its time limit, or a lost job) leaves no request open.
  await closeWaitingReviews(deps, tx, { helperId: helper.id }, "expired");
  const kind = helper.type === "general" ? "General Helper" : "Computer-use Helper";
  await receive(deps, tx, {
    id: `helper:${helper.id}`,
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
  deps.runner.wake();
  await hintChanged(deps, conversationId);
}

/**
 * The job's `onFailed`, once the runner has given up on it: ends a Helper still `running` `error`
 * with what its recorded Checkpoints hold, and it still reports back.
 */
async function endLostHelper(deps: BotSdkContext, helperId: string, waitedSince?: string) {
  const helper = await helperFacts(deps.db, helperId);
  if (helper?.status !== "running") return;
  let played: Pick<PlayedHelper, "input" | "transcript" | "usage"> = {
    input: helper.transcript ?? helperInput(helper),
    transcript: [],
    usage: null,
  };
  try {
    played = await replayedHelper(deps, helper, waitedSince);
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
async function replayedHelper(deps: BotSdkContext, helper: HelperFacts, waitedSince?: string) {
  const history = helper.jobId ? await loadHistory(deps.db, helper.jobId) : [];
  const workflow = createWorkflow<Transaction>({
    history,
    store: { save: async () => false, saveWith: async () => ({ saved: false }) },
    now: deps.clock,
    signal: AbortSignal.abort(new Error("The Helper's job has ended")),
  });
  const session =
    helper.screen === null ? undefined : new BrowserSession(helper.screen, helper.botId);
  return playHelper(deps, helper, workflow.context, waitedSince, undefined, session);
}

/**
 * Writes what a stopped Helper's recorded Checkpoints hold, its transcript and usage, once its stop
 * has committed: its cancelled job saves no more Checkpoints, so a replay reads the same each time.
 * Best-effort: the Helper stays stopped, and only its transcript is lost.
 */
async function recordStoppedHelper(deps: BotSdkContext, helperId: string): Promise<void> {
  try {
    const helper = await helperFacts(deps.db, helperId);
    if (helper?.status !== "stopped") return;
    const played = await replayedHelper(deps, helper);
    await deps.db.transaction(async (tx) => {
      await lockConversation(tx, helper.conversationId);
      await tx
        .update(botHelper)
        .set({
          transcript: [...played.input, ...played.transcript],
          usage: usageSoFar(helper, played),
        })
        .where(eq(botHelper.id, helperId));
      // Its card's Steps come from the transcript.
      await recordBotChange(tx, helper, "helper", helperId, deps.clock());
    });
    await hintChanged(deps, helper.conversationId);
  } catch (caught) {
    deps.logger.error(`Replaying the Checkpoints of Helper ${helperId} failed`, caught);
  }
}

/** The runner job that finishes a stop, once it has committed. */
export const helperStoppedJobName = "bot.helper.stopped";

/**
 * What a stop leaves to after its commit, enqueued in its transaction (`stopHelpers`), so it runs
 * only once the stop stands, and again after a crash: the stopped Helper's transcript and usage
 * become what its Checkpoints hold (unless it was waiting, and saved them then), and its Screen is
 * closed. Each part is best-effort and logged, and the same however often it runs.
 */
export const helperStoppedJob = defineCoreJob({
  name: helperStoppedJobName,
  payload: z.object({
    helperId: z.uuid(),
    userId: z.string(),
    screen: z.number().int().nullable(),
    waited: z.boolean(),
  }),
  run: async ({ helperId, userId, screen, waited }, ctx) => {
    if (!waited) await recordStoppedHelper(ctx.deps, helperId);
    await closeScreen(ctx.deps, { id: helperId, userId, screen });
  },
});

/**
 * Whether a live Demonstration holds a Screen (spec #713): Bot `botId`'s, or with `userId` any of
 * the user's, which is a busy check, since the user drives the Computer meanwhile.
 */
export async function hasLiveDemonstration(
  db: Database | Transaction,
  owner: { botId: string } | { userId: string },
): Promise<boolean> {
  const [live] = await db
    .select({ id: botDemonstration.id })
    .from(botDemonstration)
    .where(
      and(
        "botId" in owner
          ? eq(botDemonstration.botId, owner.botId)
          : eq(botDemonstration.userId, owner.userId),
        inArray(botDemonstration.state, [...liveDemonstrationStates]),
      ),
    )
    .limit(1);
  return live !== undefined;
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
  const runner = deps.runner;
  for (const { id } of rows) await runner.cancelIn(tx, helperJobKey(id));
}
