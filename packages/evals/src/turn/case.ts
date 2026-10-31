import { sendAndFollow } from "@ai-chat/test-support/follow-send";
// One eval run of one case, through the real `bot` plugin: a fresh user and Bot, the case's history
// written as earlier Turns, then `sendToBot` with the new user Message.

import { randomUUID } from "node:crypto";

import { user as userTable } from "@ai-chat/db/schema/auth";
import type { ModelMessage } from "@tanstack/ai";
import { desc, eq } from "drizzle-orm";

import { botTurn } from "@botsdk/bot/storage";
import { appendMessage } from "@botsdk/bot/chat/message-tree";
import type { Database } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { SdkOver } from "@botsdk/bot/over";
import { createBot, findBot, textParts } from "@botsdk/bot/bot/conversation";
import { sendToUserToolName } from "@botsdk/bot/bot/context";
import { saveCredentials } from "@botsdk/bot/models/internal";
import type { Credentials } from "@botsdk/bot/models/internal";
import type { TurnCase } from "./cases";
import { toolCallsOf } from "./routine-score";
import { type Observed, observeTranscript, type Score, scoreTurn } from "./score";

/** Everything a run needs that is shared by the whole eval. */
export type TurnEnv = {
  db: Database;
  sdk: SdkOver;
  /** The Bot's Model, a curated `"provider:model"`. */
  model: string;
  /**
   * The Credentials the user saves for the Model's Provider, or `null` when the Model runs on the
   * owner's linked ChatGPT plan (src/chatgpt-plan.ts), so no key is saved.
   */
  credentialsFor: (caseId: string, repeat: number) => Credentials | null;
};

/** What one run produced. */
export type TurnRunResult = {
  caseId: string;
  repeat: number;
  expected: TurnCase["expected"];
  score: Score;
  /** The text of each Message the Bot sent. */
  sent: string[];
  /** Every tool call the Turn made, in order, with its args. */
  toolCalls: { name: string; args: unknown }[];
  ms: number;
  error?: string;
};

/**
 * Writes the history the way Turns leave it: each user Message, then a Turn whose transcript holds
 * the Bot's SendToUser calls (the Bot's own Messages are not replayed as text). A ms apart, so the
 * order is the history's.
 */
export async function seedHistory(
  db: Database,
  { botId, conversationId }: { botId: string; conversationId: string },
  history: TurnCase["history"],
) {
  let at = Date.now() - 24 * 60 * 60 * 1000;
  for (const [index, exchange] of history.entries()) {
    const userAt = new Date((at += 1000));
    await db.transaction(async (tx) => {
      await appendMessage(tx, conversationId, {
        role: "user",
        parts: textParts(exchange.user),
        status: "complete",
        createdAt: userAt,
      });
      const calls = exchange.bot.map((text, i) => ({
        id: `seed-${index}-${i}`,
        type: "function" as const,
        function: {
          name: sendToUserToolName,
          arguments: JSON.stringify({ text, endTurn: i === exchange.bot.length - 1 }),
        },
      }));
      const transcript: ModelMessage[] = calls.length
        ? [
            { role: "assistant", content: "", toolCalls: calls },
            ...calls.map((call) => ({
              role: "tool" as const,
              toolCallId: call.id,
              content: JSON.stringify({ sent: true }),
            })),
          ]
        : [];
      await tx.insert(botTurn).values({
        id: uuidv7(),
        botId,
        conversationId,
        status: "complete",
        startedAt: new Date(userAt.getTime() + 1),
        endedAt: new Date(userAt.getTime() + 2),
        // The user Message as a Turn stores its input; with none, the Turn reads as one from before
        // inputs were stored, whose Messages are never rendered into the prompt.
        input: [{ role: "user", content: exchange.user }],
        transcript,
      });
      for (const [i, text] of exchange.bot.entries()) {
        await appendMessage(tx, conversationId, {
          role: "assistant",
          parts: textParts(text),
          status: "complete",
          createdAt: new Date(userAt.getTime() + 2 + i),
        });
      }
    });
    at += 1000;
  }
}

/** A fresh user with Credentials for the Model's Provider, and a Bot on that Model. */
export async function freshBot(env: TurnEnv, caseId: string, repeat: number) {
  const userId = randomUUID();
  await env.db
    .insert(userTable)
    .values({ id: userId, name: "Eval", email: `${userId}@eval.invalid` });
  const provider = env.model.split(":")[0]!;
  const fields = env.credentialsFor(caseId, repeat);
  if (fields) {
    await saveCredentials(env.sdk, userId, {
      service: provider,
      fields,
      hint: "eval",
      verified: true,
    });
  }
  const bot = await createBot(env.db, userId, { name: "Eval", model: env.model }, new Date());
  const found = await findBot(env.db, userId, bot.id);
  return { userId, bot, found };
}

/** Runs one case once and scores the Turn. A failure before the Turn ends counts as a failed run. */
export async function runCase(
  env: TurnEnv,
  evalCase: TurnCase,
  repeat: number,
): Promise<TurnRunResult> {
  const started = Date.now();
  const sent: string[] = [];
  try {
    const { userId, bot, found } = await freshBot(env, evalCase.id, repeat);
    await seedHistory(
      env.db,
      { botId: bot.id, conversationId: found!.conversationId },
      evalCase.history,
    );

    let status: Observed["status"] = "stopped";
    for await (const event of await sendAndFollow(env.sdk, {
      userId,
      botId: bot.id,
      id: uuidv7(),
      text: evalCase.message,
    })) {
      if (event.type === "message" && event.message.role === "assistant")
        sent.push(event.message.text);
      if (event.type === "turnEnded") status = event.status;
    }
    const [turn] = await env.db
      .select({ transcript: botTurn.transcript, error: botTurn.error })
      .from(botTurn)
      .where(eq(botTurn.botId, bot.id))
      .orderBy(desc(botTurn.startedAt))
      .limit(1);
    const observed: Observed = {
      status,
      error: turn?.error,
      messages: sent.length,
      ...observeTranscript(turn?.transcript),
    };
    return {
      caseId: evalCase.id,
      repeat,
      expected: evalCase.expected,
      score: scoreTurn(evalCase, observed),
      sent,
      toolCalls: toolCallsOf(turn?.transcript),
      ms: Date.now() - started,
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    return {
      caseId: evalCase.id,
      repeat,
      expected: evalCase.expected,
      score: {
        expected: evalCase.expected,
        passed: false,
        endTurn: null,
        reasons: [`error: ${error}`],
      },
      sent,
      toolCalls: [],
      ms: Date.now() - started,
      error,
    };
  }
}
