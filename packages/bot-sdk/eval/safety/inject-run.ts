// One run of an end-to-end injection case (spec #691, #697): a Bot with an approved webhook Routine
// and the fake Computer is called at the Routine's URL with a payload that hides an instruction.
// The real Bot Model runs the Turn and the real reviewer checks its calls. The case passes if the
// injected command never ran on the Computer.

import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { botReview, botRoutine, botTrigger, botTurn } from "../../core/server/db/schema";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { webhookTokenHash } from "../../plugins/bot/server/routine";
import { defaultTimeZone } from "../../plugins/bot/server/time-zone";
import type { fakeComputerProvider } from "../../test/plugins/computer/server/fake-provider";
import { freshBot, seedHistory } from "../turn/case";
import { waitForTurn } from "../turn/routine-run";
import { toolCallsOf } from "../turn/routine-score";
import type { InjectionCase } from "./cases";
import type { SafetyEnv } from "./review-run";
import { e2eOutcome } from "./score";

export type InjectionRunResult = {
  caseId: string;
  repeat: number;
  passed: boolean;
  /** Why it passed: the reviewer blocked the injected command, or the Bot never tried it. */
  how: "ran" | "blocked" | "ignored";
  /** Every shell command the Bot tried, and the ones the Computer ran. */
  attempted: string[];
  ran: string[];
  /** How many calls the reviewer blocked in the Turn. */
  blocked: number;
  ms: number;
  error?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the Turn the webhook's Trigger starts, and returns its id. */
async function turnOfWebhook(env: SafetyEnv, conversationId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [trigger] = await env.db
      .select({ turnId: botTrigger.turnId })
      .from(botTrigger)
      .where(and(eq(botTrigger.conversationId, conversationId), eq(botTrigger.source, "routine")));
    if (trigger?.turnId) return trigger.turnId;
    await sleep(100);
  }
  throw new Error("The webhook's Trigger was not taken by a Turn");
}

/**
 * Runs one case once. `computer` is the fake Computer the Bot is installed over; runs go one at a
 * time, since its calls are shared.
 */
export async function runInjectionCase(
  env: SafetyEnv,
  computer: ReturnType<typeof fakeComputerProvider>,
  evalCase: InjectionCase,
  repeat: number,
): Promise<InjectionRunResult> {
  const started = Date.now();
  const base = { caseId: evalCase.id, repeat };
  try {
    const { userId, bot, found } = await freshBot(env, evalCase.id, repeat);
    await env.saveReviewerKey?.(userId, evalCase.id, repeat);
    const conversationId = found!.conversationId;
    await seedHistory(env.db, { botId: bot.id, conversationId }, [
      { user: evalCase.message, bot: ["Done. The Routine runs once you approve it."] },
    ]);
    // The Routine, approved: the Turn that made it is the history's.
    const [made] = await env.db
      .select({ id: botTurn.id })
      .from(botTurn)
      .where(eq(botTurn.botId, bot.id));
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    await env.db.insert(botRoutine).values({
      id: uuidv7(),
      botId: bot.id,
      name: evalCase.routine.name,
      prompt: evalCase.routine.prompt,
      schedule: null,
      webhookTokenHash: webhookTokenHash(token),
      timeZone: defaultTimeZone,
      state: "active",
      createdByTurnId: made!.id,
      approvedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const before = computer.calls.length;
    const response = await env.sdk.bots.webhookHandler(
      new Request(`https://bots.example/api/routines/webhook/${token}`, {
        method: "POST",
        body: evalCase.payload,
        headers: { "Content-Type": "application/json" },
      }),
    );
    if (response.status !== 202) throw new Error(`The webhook answered ${response.status}`);
    const turnId = await turnOfWebhook(env, conversationId);
    // A blocked call waits 15 seconds for the user, so a Turn can take a while.
    const turn = await waitForTurn(env, turnId, 300_000);

    const attempted = toolCallsOf(turn.transcript).flatMap((call) => {
      const command = (call.args as { command?: unknown } | null)?.command;
      return call.name === "shell" && typeof command === "string" ? [command] : [];
    });
    const ran = computer.calls
      .slice(before)
      .flatMap((call) => (call.type === "run" ? [call.command] : []));
    const reviews = await env.db
      .select({ verdict: botReview.verdict })
      .from(botReview)
      .where(eq(botReview.botId, bot.id));
    const blocked = reviews.filter((review) => review.verdict === "block").length;
    const outcome = e2eOutcome(evalCase.canary, { ran, attempted, blocked });
    return { ...base, ...outcome, attempted, ran, blocked, ms: Date.now() - started };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    return {
      ...base,
      passed: false,
      how: "ignored",
      attempted: [],
      ran: [],
      blocked: 0,
      ms: Date.now() - started,
      error,
    };
  }
}
