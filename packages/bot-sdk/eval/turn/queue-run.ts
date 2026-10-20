// One run of a step-3 eval case (spec #510), through the real `bot` plugin: a fresh user and Bot,
// then each of the case's Messages sent with `sendToBot` and a client id, as the web client does.

import { and, asc, eq, inArray } from "drizzle-orm";

import { botTurn } from "../../core/server/db/schema";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { job } from "../../plugins/runner/server/db/job";
import { botTrigger } from "../../plugins/bot/server/db/bot-trigger";
import { sendToBot } from "../../plugins/bot/server/turn";
import { freshBot, type TurnEnv } from "./case";
import type { QueueCase } from "./queue-cases";
import { judge, scoreQueue } from "./queue-score";
import { toolCallsOf } from "./routine-score";
import { sentTexts } from "./score";

/** The judge's completion; the eval run builds it from `EVAL_JUDGE_MODEL`. */
export type Complete = (prompt: string) => Promise<string>;

export type QueueRunResult = {
  caseId: QueueCase["id"];
  repeat: number;
  structural: { passed: boolean; reasons: string[] };
  /** The judge's verdict and reason; `null` when the Bot sent nothing, so there was no reply to judge. */
  judge: { correct: boolean; reason: string } | null;
  /** The text the last Turn sent. */
  reply: string[];
  /** Every tool call the Turns that took the Messages made, in order, with its args. */
  toolCalls: { name: string; args: unknown }[];
  ms: number;
  error?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until a job of the Bot's Turns is running, or throws after `timeoutMs`. */
async function waitForTurnStart(env: TurnEnv, botId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [running] = await env.db
      .select({ id: job.id })
      .from(job)
      .innerJoin(botTurn, eq(botTurn.jobId, job.id))
      .where(and(eq(botTurn.botId, botId), eq(job.status, "running")))
      .limit(1);
    if (running) return;
    await sleep(50);
  }
  throw new Error("The Bot's Turn did not start");
}

/** Runs one case once, scores its Turns and Triggers, and judges the last Turn's reply. */
export async function runQueueCase(
  env: TurnEnv,
  complete: Complete,
  evalCase: QueueCase,
  repeat: number,
): Promise<QueueRunResult> {
  const started = Date.now();
  let reply: string[] = [];
  let toolCalls: QueueRunResult["toolCalls"] = [];
  try {
    const { userId, bot } = await freshBot(env, evalCase.id, repeat);
    const ids: string[] = [];
    const streams: Promise<void>[] = [];
    // When the next Message is due: `afterMs` counts from the previous Message's due time, not from
    // when its send returned, so a slow send under load doesn't stretch the gaps past the batch's
    // quiet window (#603).
    let due = Date.now();
    for (const message of evalCase.messages) {
      if (message.afterTurnStarts) {
        await waitForTurnStart(env, bot.id);
        due = Date.now();
      } else if (message.afterMs) {
        due += message.afterMs;
        await sleep(Math.max(0, due - Date.now()));
      }
      const id = uuidv7();
      ids.push(id);
      const stream = await sendToBot(env.sdk, { userId, botId: bot.id, id, text: message.text });
      streams.push(
        (async () => {
          for await (const _ of stream);
        })(),
      );
    }
    await Promise.all(streams);

    const turns = await env.db
      .select({ id: botTurn.id, status: botTurn.status, transcript: botTurn.transcript })
      .from(botTurn)
      .where(eq(botTurn.botId, bot.id))
      .orderBy(asc(botTurn.startedAt));
    const triggers = turns.length
      ? await env.db
          .select({ id: botTrigger.id, turnId: botTrigger.turnId })
          .from(botTrigger)
          .where(inArray(botTrigger.id, ids))
      : [];
    const taking = turns
      .map((turn) => ({
        status: turn.status,
        triggerIds: triggers.filter((t) => t.turnId === turn.id).map((t) => t.id),
        transcript: turn.transcript,
        sent: sentTexts(turn.transcript).length,
      }))
      .filter((turn) => turn.triggerIds.length > 0);
    const structural = scoreQueue(evalCase.id, { triggerIds: ids, turns: taking });
    reply = sentTexts(taking.at(-1)?.transcript);
    toolCalls = taking.flatMap((turn) => toolCallsOf(turn.transcript));
    const verdict = reply.length
      ? await judge(complete, { criterion: evalCase.criterion, reply: reply.join("\n") })
      : null;
    return {
      caseId: evalCase.id,
      repeat,
      structural,
      judge: verdict,
      reply,
      toolCalls,
      ms: Date.now() - started,
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    return {
      caseId: evalCase.id,
      repeat,
      structural: { passed: false, reasons: [`error: ${error}`] },
      judge: null,
      reply,
      toolCalls,
      ms: Date.now() - started,
      error,
    };
  }
}
