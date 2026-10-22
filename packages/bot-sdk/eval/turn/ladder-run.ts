import { sendAndFollow } from "../../test/support/follow-send";
// One run of a step-6 ladder case (spec #587), through the real `bot` plugin with the `computer`
// plugin on, so the Turn has the Computer system prompt and the Helper tools: a fresh user and Bot,
// the case's history, then a user Message or a Helper's report as the Trigger.

import { eq } from "drizzle-orm";

import { botTrigger } from "../../core/server/db/schema";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { gistOf } from "../../plugins/bot/server/helper";
import { lockConversation, receive } from "../../plugins/bot/server/router";
import { saveCredentials } from "../../plugins/models/server/credentials/store";
import { tavilyService } from "../../plugins/models/shared/credentials/services";
import { freshBot, seedHistory, type TurnEnv } from "./case";
import type { LadderCase } from "./ladder-cases";
import { helperStarts, scoreLadder } from "./ladder-score";
import type { Complete } from "./queue-run";
import { judge } from "./queue-score";
import { turnIdOf, toolCallsOf } from "./routine-score";
import { waitForTurn } from "./routine-run";
import { sentTexts } from "./score";

export type LadderRunResult = {
  caseId: string;
  repeat: number;
  structural: { passed: boolean; reasons: string[] };
  /** The judge's verdict and reason; `null` when there was nothing to judge. */
  judge: { correct: boolean; reason: string } | null;
  /** The text the Turn sent. */
  reply: string[];
  /** The type and task of each `start_helper` call. */
  helpers: { type: string; task: string }[];
  /** Every tool call the Turn made, in order, with its args. */
  toolCalls: { name: string; args: unknown }[];
  ms: number;
  error?: string;
};

/** The Trigger text a Helper's end hands the Router (the shape `endHelper` writes). */
function helperReportText(start: Extract<LadderCase["start"], { kind: "helper" }>): string {
  const kind = start.type === "general" ? "General Helper" : "Computer-use Helper";
  return `${kind} finished: ${gistOf(start.task)}, status complete\n\n${start.report}`;
}

/** Runs one case once, scores its Turn, and judges the task it handed over or its reply. */
export async function runLadderCase(
  env: TurnEnv,
  complete: Complete,
  evalCase: LadderCase,
  repeat: number,
): Promise<LadderRunResult> {
  const started = Date.now();
  let reply: string[] = [];
  let helpers: LadderRunResult["helpers"] = [];
  let toolCalls: LadderRunResult["toolCalls"] = [];
  try {
    const { userId, bot, found } = await freshBot(env, evalCase.id, repeat);
    if (evalCase.webSearch) {
      await saveCredentials(env.sdk, userId, {
        service: tavilyService,
        fields: { apiKey: "tvly-eval" },
        hint: "eval",
        verified: true,
      });
    }
    await seedHistory(
      env.db,
      { botId: bot.id, conversationId: found!.conversationId },
      evalCase.history ?? [],
    );
    const { start } = evalCase;
    let turnId: string;
    if (start.kind === "user") {
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
        return receive(env.sdk, tx, {
          id: uuidv7(),
          conversationId: found!.conversationId,
          source: "helper",
          channel: "helper",
          text: helperReportText(start),
          receivedAt: now,
        });
      });
      turnId = turnIdOf(taken);
      env.sdk.plugin("runner").wake();
    }
    const turn = await waitForTurn(env, turnId);
    reply = sentTexts(turn.transcript);
    helpers = helperStarts(turn.transcript);
    toolCalls = toolCallsOf(turn.transcript);
    const structural = scoreLadder(evalCase.expect, {
      status: turn.status,
      helperTypes: helpers.map((helper) => helper.type),
      sent: reply.length,
    });

    // The task of the first Helper started, or the Messages sent.
    const judged = evalCase.judge.on === "task" ? (helpers[0]?.task ?? "") : reply.join("\n");
    if (evalCase.judge.on === "task" && !judged) {
      structural.passed = false;
      structural.reasons.push("nothing to judge: no start_helper task");
    }
    const verdict = judged
      ? await judge(complete, { criterion: evalCase.judge.criterion, reply: judged })
      : null;
    return {
      caseId: evalCase.id,
      repeat,
      structural,
      judge: verdict,
      reply,
      helpers,
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
      helpers,
      toolCalls,
      ms: Date.now() - started,
      error,
    };
  }
}
