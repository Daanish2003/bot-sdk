// One eval case, end to end: a fresh user, the case's history ingested session by session with the
// Memory job run after each reply, then the question asked as a Run and judged.

import { randomUUID } from "node:crypto";

import { user as userTable } from "@ai-chat/db/schema/auth";
import { and, eq } from "drizzle-orm";

import { createChatHandler, type SdkOver } from "../../core/server/create-chat";
import { saveCredentials } from "../../plugins/models/server/credentials/store";
import { conversation, message, type MessageRow } from "../../core/server/db/schema";
import type { Database } from "../../core/server/db/index";
import type { Credentials } from "../../core/server/deps";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { makeMemoriesJob } from "../../core/server/memory/make";
import { storedParts } from "../../core/shared/message-parts";
import { type Category, type EvalCase, historyOf, parseDate } from "./cases";
import { judge } from "./judge";

/** What one case produced: the reply, the judge's verdict, and how long it took. */
export type CaseResult = {
  questionId: string;
  category: Category;
  question: string;
  expected: string;
  hypothesis: string;
  judgeReply: string;
  correct: boolean;
  sessions: number;
  ms: number;
  /** Set when the case failed before the judge; the case then counts as wrong. */
  error?: string;
};

/** Everything a case needs that is shared by the whole run. */
/** The core context with the models plugin's bundle, as the handler takes them. */
export type EvalDeps = SdkOver;

export type EvalEnv = {
  db: Database;
  /** The SDK's dependencies, with the Models and the clock left for each case to set. */
  base: EvalDeps;
  answerModel: string;
  /** The Providers the run's Models use, plus OpenAI for embeddings; each gets the user's key. */
  providers: string[];
  keyFor: (provider: string) => Credentials;
  /** The judge Model's completion, at temperature 0. */
  complete: (prompt: string) => Promise<string>;
};

/** Makes a user with a unique id, the way the Host's auth would. */
async function insertUser(db: Database): Promise<string> {
  const id = randomUUID();
  await db.insert(userTable).values({ id, name: "Eval", email: `${id}@eval.invalid` });
  return id;
}

/** Writes one Conversation's Messages as a chain, the way a Run and an edit would. */
async function insertConversation(
  db: Database,
  fields: { userId: string; model: string; title: string | null; createdAt: Date },
) {
  const [row] = await db
    .insert(conversation)
    .values({ id: uuidv7(fields.createdAt.getTime()), ...fields })
    .returning();
  return row!;
}

/**
 * Ingests one case's history: each session is its own Conversation, dated at the session, with its
 * Messages at that date. After each assistant reply the Memory job runs inline, with the clock at
 * the session date, as it would after the Run.
 */
async function ingest(env: EvalEnv, deps: EvalDeps, userId: string, item: EvalCase["item"]) {
  const sessions = historyOf(item);
  for (const session of sessions) {
    const conv = await insertConversation(env.db, {
      userId,
      model: env.answerModel,
      title: null,
      createdAt: session.date,
    });
    let parentId: string | null = null;
    for (const [index, turn] of session.turns.entries()) {
      const createdAt = new Date(session.date.getTime() + index * 1000);
      const [row]: MessageRow[] = await env.db
        .insert(message)
        .values({
          id: uuidv7(createdAt.getTime()),
          conversationId: conv.id,
          parentId,
          role: turn.role,
          parts: storedParts([{ type: "text", text: turn.content }]),
          searchText: turn.content,
          model: turn.role === "assistant" ? env.answerModel : null,
          status: "complete",
          createdAt,
        })
        .returning();
      parentId = row!.id;
      await env.db
        .update(conversation)
        .set({ activeLeafId: row!.id })
        .where(eq(conversation.id, conv.id));
      if (turn.role === "assistant") {
        await makeMemoriesJob.run(
          { userId, conversationId: conv.id, replyId: row!.id },
          { deps: { ...deps, clock: () => session.date }, signal: new AbortController().signal },
        );
      }
    }
  }
}

/** The text of the assistant Message a Run wrote in a Conversation (a new one has exactly one). */
async function replyText(db: Database, conversationId: string): Promise<string> {
  const [reply] = await db
    .select({ text: message.searchText })
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.role, "assistant")));
  if (!reply) throw new Error("The question's Run wrote no reply");
  return reply.text;
}

/** Saves the user's own API key for each Provider the run uses (BYOK), so the SDK resolves them. */
async function saveKeys(env: EvalEnv, deps: EvalDeps, userId: string) {
  for (const provider of env.providers) {
    await saveCredentials(deps, userId, {
      service: provider,
      fields: env.keyFor(provider),
      hint: "eval",
      verified: true,
    });
  }
}

/** Asks the question as a Run in a new Conversation dated at the question date, then reads the reply. */
async function ask(env: EvalEnv, deps: EvalDeps, userId: string, item: EvalCase["item"]) {
  const questionDate = parseDate(item.question_date);
  const conv = await insertConversation(env.db, {
    userId,
    model: env.answerModel,
    title: "Question",
    createdAt: questionDate,
  });
  const handler = createChatHandler(
    { ...deps, clock: () => questionDate },
    {
      basePath: "/api/chat",
      getUser: () => ({ id: userId }),
      logger: { error: () => {} },
    },
  );
  const response = await handler(
    new Request("http://localhost/api/chat/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        forwardedProps: {
          conversationId: conv.id,
          parentId: null,
          text: item.question,
          attachmentIds: [],
          model: env.answerModel,
          webSearch: false,
        },
      }),
    }),
  );
  // The reply is in the database once the stream has ended.
  await response.text();
  return replyText(env.db, conv.id);
}

/** Runs one case: its own user, its history, the question, and the judge's verdict. */
export async function runCase(env: EvalEnv, evalCase: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  const { item, category } = evalCase;
  const expected = String(item.answer);
  const base = {
    questionId: item.question_id,
    category,
    question: item.question,
    expected,
    sessions: historyOf(item).length,
  };
  try {
    const userId = await insertUser(env.db);
    const deps: EvalDeps = { ...env.base };
    await saveKeys(env, deps, userId);
    await ingest(env, deps, userId, item);
    const hypothesis = await ask(env, deps, userId, item);
    const verdict = await judge(env.complete, {
      category,
      question: item.question,
      expected,
      response: hypothesis,
    });
    return {
      ...base,
      hypothesis,
      judgeReply: verdict.reply,
      correct: verdict.correct,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      hypothesis: "",
      judgeReply: "",
      correct: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
