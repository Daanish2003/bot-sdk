import { sendAndFollow } from "../../test/support/follow-send";
// One run of a step-4 eval case (spec #543), through the real `bot` plugin: a fresh user and Bot, the
// case's history, then either a user Message or a Trigger as a Routine's run or a fired Check-in hands
// the Router (the same `receive`, with the text `routineSnapshot` and `checkInNotice` make).

import { eq } from "drizzle-orm";

import { botTrigger, botTurn } from "../../core/server/db/schema";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { checkInNotice } from "../../plugins/bot/server/check-in";
import { lockConversation, receive } from "../../plugins/bot/server/router";
import { routineSnapshot } from "../../plugins/bot/server/routine";
import { defaultTimeZone } from "../../plugins/bot/server/time-zone";
import { freshBot, seedHistory, type TurnEnv } from "./case";
import type { RoutineCase } from "./routine-cases";
import {
  callNames,
  callsToJudge,
  failEmptyJudgement,
  scoreRoutine,
  toolCallsOf,
  turnIdOf,
} from "./routine-score";
import { judge } from "./queue-score";
import type { Complete } from "./queue-run";
import { sentTexts } from "./score";

export type RoutineRunResult = {
  caseId: string;
  repeat: number;
  structural: { passed: boolean; reasons: string[] };
  /** The judge's verdict and reason; `null` when the case has no judge check or there was nothing to judge. */
  judge: { correct: boolean; reason: string } | null;
  /** The Messages the Turn sent. */
  reply: string[];
  /** The tool calls the Turn made, in order. */
  calls: string[];
  /** Every tool call the Turn made, in order, with its args. */
  toolCalls: { name: string; args: unknown }[];
  ms: number;
  error?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the Turn `turnId` is no longer running, and returns it. */
export async function waitForTurn(env: TurnEnv, turnId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [turn] = await env.db
      .select({
        status: botTurn.status,
        transcript: botTurn.transcript,
        startedAt: botTurn.startedAt,
      })
      .from(botTurn)
      .where(eq(botTurn.id, turnId));
    if (turn && turn.status !== "running") return turn;
    await sleep(100);
  }
  throw new Error("The Bot's Turn did not end");
}

/** Runs one case once, scores the Turn it started, and judges what the case asks to judge. */
export async function runRoutineCase(
  env: TurnEnv,
  complete: Complete,
  evalCase: RoutineCase,
  repeat: number,
): Promise<RoutineRunResult> {
  const started = Date.now();
  let reply: string[] = [];
  let calls: string[] = [];
  let toolCalls: RoutineRunResult["toolCalls"] = [];
  try {
    const { userId, bot, found } = await freshBot(env, evalCase.id, repeat);
    await seedHistory(
      env.db,
      { botId: bot.id, conversationId: found!.conversationId },
      evalCase.history ?? [],
    );
    const { start } = evalCase;
    let turnId: string;
    if (start.kind === "user") {
      // The Message's id is its Trigger's id; the Trigger names the Turn that took it.
      const id = uuidv7();
      for await (const _ of await sendAndFollow(env.sdk, {
        userId,
        botId: bot.id,
        id,
        text: start.message,
      })) {
        // Drained: the stream ends when the Turn does.
      }
      const [trigger] = await env.db
        .select({ turnId: botTrigger.turnId })
        .from(botTrigger)
        .where(eq(botTrigger.id, id));
      if (!trigger?.turnId) throw new Error("No Turn took the user Message");
      turnId = trigger.turnId;
    } else {
      const now = new Date();
      const taken = await env.db.transaction(async (tx) => {
        await lockConversation(tx, found!.conversationId);
        const text =
          start.kind === "routine"
            ? routineSnapshot({
                name: start.name,
                prompt: start.prompt,
                slot: now,
                timeZone: defaultTimeZone,
              })
            : await checkInNotice(tx, found!.conversationId, {
                createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
                at: now,
                note: start.note,
              });
        return receive(env.sdk, tx, {
          id: uuidv7(),
          conversationId: found!.conversationId,
          source: start.kind,
          channel: "schedule",
          text,
          receivedAt: now,
        });
      });
      turnId = turnIdOf(taken);
      env.sdk.plugin("runner").wake();
    }
    const turn = await waitForTurn(env, turnId);
    calls = callNames(turn.transcript);
    toolCalls = toolCallsOf(turn.transcript);
    reply = sentTexts(turn.transcript);
    let structural = scoreRoutine(evalCase.expect, {
      status: turn.status,
      calls,
      sent: reply.length,
    });

    let verdict: RoutineRunResult["judge"] = null;
    const { judge: check } = evalCase;
    if (check) {
      // The clock is the Turn's own and the zone the Bot's (the user sent none, so the default).
      let judged = reply.join("\n");
      let rejection: string | undefined;
      if (check.on !== "reply") {
        ({ text: judged, rejection } = callsToJudge(
          turn.transcript,
          check.on,
          turn.startedAt,
          defaultTimeZone,
        ));
      }
      if (rejection) {
        structural = { passed: false, reasons: [...structural.reasons, rejection] };
      } else structural = failEmptyJudgement(structural, judged, check.on);
      if (judged) verdict = await judge(complete, { criterion: check.criterion, reply: judged });
    }
    return {
      caseId: evalCase.id,
      repeat,
      structural,
      judge: verdict,
      reply,
      calls,
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
      calls,
      toolCalls,
      ms: Date.now() - started,
      error,
    };
  }
}
