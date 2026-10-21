// One run of a reviewer case (spec #691, #697): the case's Messages, Turn start and call are written
// into a fresh Bot's Conversation, then the real Auto-review (`judge`, the reviewer's own call) gives
// its verdict. Nothing runs: only the verdict is read.

import { appendMessage } from "../../core/server/chat/message-tree";
import { botTrigger, botTurn } from "../../core/server/db/schema";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { judge, type ReviewKit, reviewFailedReason } from "../../plugins/bot/server/review";
import { routineSnapshot, webhookPayloadLabel } from "../../plugins/bot/server/routine";
import { defaultTimeZone } from "../../plugins/bot/server/time-zone";
import { textParts } from "../../plugins/bot/server/store";
import { freshBot, type TurnEnv } from "../turn/case";
import type { ReviewCase } from "./cases";
import type { Outcome } from "./score";

export type ReviewRunResult = {
  caseId: string;
  group: ReviewCase["group"];
  repeat: number;
  expected: Outcome;
  /** The verdict; a reviewer that failed to answer counts as a block, as it does for a Bot. */
  actual: Outcome;
  /** Whether the reviewer failed, timed out or gave no verdict (a block with its fixed reason). */
  failed: boolean;
  reason: string;
  summary: string;
  ms: number;
  error?: string;
};

/** The Auto-review Model, and everything else a run shares with the Turn evals. */
export type SafetyEnv = TurnEnv & {
  /** Saves the key of the reviewer's Provider for a user whose Bot runs on another Provider. */
  saveReviewerKey?: (userId: string, caseId: string, repeat: number) => Promise<void>;
};

/** What `judge` needs of the loop: no Stop, no time limit, and nothing billed. */
const kit = {
  signal: new AbortController().signal,
  beforeLive: () => {},
  usageOf: () => null,
} as unknown as ReviewKit;

/** The text of a webhook Trigger: the Routine's snapshot, then the payload as the Router fences it. */
function webhookText(snapshot: string, payload: string): string {
  return `${snapshot}\n\n${webhookPayloadLabel}\n\`\`\`\n${payload}\n\`\`\``;
}

/** Runs one reviewer case once and reads the verdict. */
export async function runReviewCase(
  env: SafetyEnv,
  evalCase: ReviewCase,
  repeat: number,
): Promise<ReviewRunResult> {
  const started = Date.now();
  const base = { caseId: evalCase.id, group: evalCase.group, repeat, expected: evalCase.expected };
  try {
    const { userId, bot, found } = await freshBot(env, evalCase.id, repeat);
    const conversationId = found!.conversationId;
    const at = Date.now() - 60 * 60 * 1000;
    for (const [index, text] of evalCase.messages.entries()) {
      await env.db.transaction((tx) =>
        appendMessage(tx, conversationId, {
          role: "user",
          parts: textParts(text),
          status: "complete",
          createdAt: new Date(at + index * 1000),
        }),
      );
    }
    // The Turn the call belongs to, and the Trigger that started it.
    const turnId = uuidv7();
    const now = new Date();
    await env.db.insert(botTurn).values({
      id: turnId,
      botId: bot.id,
      status: "running",
      startedAt: now,
      input: [],
      transcript: [],
    });
    const { start } = evalCase;
    const snapshot =
      start?.kind === "routine"
        ? routineSnapshot({
            name: start.name,
            prompt: start.prompt,
            slot: now,
            timeZone: defaultTimeZone,
          })
        : null;
    await env.db.insert(botTrigger).values(
      start?.kind === "routine"
        ? {
            id: uuidv7(),
            conversationId,
            source: "routine",
            channel: start.webhookPayload ? "webhook" : "schedule",
            text: start.webhookPayload ? webhookText(snapshot!, start.webhookPayload) : snapshot,
            turnId,
            receivedAt: now,
          }
        : start?.kind === "check_in"
          ? {
              id: uuidv7(),
              conversationId,
              source: "check_in",
              channel: "schedule",
              text: start.note,
              turnId,
              receivedAt: now,
            }
          : {
              id: uuidv7(),
              conversationId,
              source: "user",
              channel: "web",
              text: null,
              turnId,
              receivedAt: now,
            },
    );
    const source = evalCase.helperTask
      ? {
          helperId: uuidv7(),
          conversationId,
          task: evalCase.helperTask,
          startedByTurnId: turnId,
        }
      : { turnId, conversationId };
    const verdict = await judge(
      env.sdk,
      kit,
      {
        owner: { userId, model: env.model },
        source,
        tool: evalCase.tool,
        input: evalCase.input,
      },
      () => {},
    );
    return {
      ...base,
      actual: verdict.outcome,
      failed: verdict.outcome === "block" && verdict.reason === reviewFailedReason,
      reason: verdict.reason,
      summary: verdict.summary,
      ms: Date.now() - started,
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    // A run that errored before a verdict counts as a block that failed, like a reviewer failure.
    return {
      ...base,
      actual: "block",
      failed: true,
      reason: `error: ${error}`,
      summary: "",
      ms: Date.now() - started,
      error,
    };
  }
}
