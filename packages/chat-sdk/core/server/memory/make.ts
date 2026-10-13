import { chat, type ModelMessage } from "@tanstack/ai";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { isKnownModel, parseModelId } from "../../shared/chat/models";
import {
  defaultEmbeddingModel,
  embedTexts,
  type ResolvedEmbeddingModel,
} from "../chat/embedding-models";
import { recordHostUsage } from "../chat/host-usage";
import { quotaRefusal } from "../chat/quota";
import { loadPath } from "../chat/store";
import { messageUsage, promptCharactersOf, reportedUsageOf } from "../chat/usage";
import { conversation, type MessageRow } from "../db/schema/chat";
import { memory } from "../db/schema/memory";
import { userSettings } from "../db/schema/settings";
import type { AppDeps } from "../deps";
import { resolveModelCall, type ModelCall } from "../credentials/resolve";
import { uuidv7 } from "../lib/uuidv7";
import { defineJob } from "../jobs/define";
import { factExtractionPrompt } from "./prompt";

/** The Messages of a Run the job reads: its reply and the Conversation it is in. */
const makeMemoriesPayload = z.object({
  userId: z.string(),
  conversationId: z.string(),
  /** The reply's Message id: the Run that ended `complete` or `stopped` (ADR 0013). */
  replyId: z.string(),
});

export type MakeMemoriesPayload = z.infer<typeof makeMemoriesPayload>;

/** How much of each Message the extract call reads. */
const promptChars = 4_000;

const factsReply = z.object({ facts: z.array(z.string()) });

/** What a Memory job needs to run: its Background Model, the call on it, and the embedding Model. */
type MemoryPlan = {
  model: string;
  call: ModelCall;
  embedding: ResolvedEmbeddingModel;
};

/**
 * Whether Memory may run for a Run in this Conversation, and the Models it would use (ADR 0013).
 * Off for a Temporary Conversation, when Memory is off for the Host or the user, and with no
 * Background Model (the user's, else the Host's default: never the reply's Model) or no embedding
 * Model. `null` when it may not run.
 */
async function memoryPlanOf(
  deps: AppDeps,
  userId: string,
  conversationId: string,
): Promise<MemoryPlan | null> {
  if (!deps.memory) return null;
  const [row] = await deps.db
    .select({ temporary: conversation.temporary })
    .from(conversation)
    .where(eq(conversation.id, conversationId));
  if (!row || row.temporary) return null;
  const [settings] = await deps.db
    .select({
      memoryEnabled: userSettings.memoryEnabled,
      backgroundModel: userSettings.backgroundModel,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  if (settings && !settings.memoryEnabled) return null;
  const model = settings?.backgroundModel ?? deps.defaultBackgroundModel;
  if (!model || !isKnownModel(model)) return null;
  const call = await resolveModelCall(deps, userId, model);
  if (!call) return null;
  const embedding = await defaultEmbeddingModel(deps, userId);
  if (!embedding) return null;
  return { model, call, embedding };
}

/** The job that makes Memories from one Run (ADR 0013). Its key is `memory:<replyId>`. */
export const makeMemoriesJob = defineJob<MakeMemoriesPayload>({
  name: "memory.make",
  payload: makeMemoriesPayload,
  run: makeMemories,
});

/**
 * Queues the job for a Run that ended `complete` or `stopped`, when Memory may run for it. Called
 * from the Run-end hook, fire-and-forget, so a reply never waits for it.
 */
export async function enqueueMemories(deps: AppDeps, payload: MakeMemoriesPayload): Promise<void> {
  if (!(await memoryPlanOf(deps, payload.userId, payload.conversationId))) return;
  await deps.jobs.enqueue(makeMemoriesJob.name, payload, {
    idempotencyKey: `memory:${payload.replyId}`,
  });
}

/**
 * Reads the user's Message of the Run, the reply and the two Messages before the user's Message,
 * then adds one Memory per fact the Background Model extracts from the user's words (ADR 0013).
 * The user's Memory jobs run one at a time, under a Postgres advisory lock. A Message's facts are
 * never added twice, so a retried job, or a regenerated reply, adds nothing new. Ends quietly, with
 * no error, when the user is over Quota or the Models are gone.
 */
async function makeMemories(payload: MakeMemoriesPayload, deps: AppDeps): Promise<void> {
  const { userId, conversationId, replyId } = payload;
  const plan = await memoryPlanOf(deps, userId, conversationId);
  if (!plan) return;
  const metered = plan.call.hostModel !== undefined || plan.embedding.onHostCredentials;
  if (metered && (await quotaRefusal(deps, userId))) return;

  const path = await loadPath(deps, conversationId, replyId);
  const reply = path.at(-1);
  const user = path.at(-2);
  if (!reply || reply.id !== replyId || !user || user.role !== "user") return;
  const before = path.slice(Math.max(0, path.length - 4), path.length - 2);

  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`memory:${userId}`}, 0))`);
    const [made] = await tx
      .select({ id: memory.id })
      .from(memory)
      .where(eq(memory.sourceMessageId, user.id))
      .limit(1);
    if (made) return;

    const now = deps.clock();
    const facts = await extractFacts(deps, {
      userId,
      plan,
      transcript: transcriptOf([...before, user, reply]),
      now,
    });
    if (facts.length === 0) return;
    const vectors = await embedTexts(deps, {
      userId,
      model: plan.embedding,
      texts: facts,
      purpose: "document",
    });
    await tx.insert(memory).values(
      facts.map((text, i) => ({
        id: uuidv7(now.getTime()),
        userId,
        text,
        embedding: vectors[i]!,
        embeddingModel: plan.embedding.id,
        conversationId,
        sourceMessageId: user.id,
        origin: "extracted" as const,
        createdAt: now,
        updatedAt: now,
      })),
    );
  });
}

/** The facts the Background Model reads in the transcript, as JSON validated with Zod (ADR 0013). */
async function extractFacts(
  deps: AppDeps,
  {
    userId,
    plan,
    transcript,
    now,
  }: { userId: string; plan: MemoryPlan; transcript: string; now: Date },
): Promise<string[]> {
  const messages: ModelMessage[] = [{ role: "user", content: transcript }];
  const result = await chat({
    adapter: deps.adapterFor(plan.model, plan.call.credentials, {
      maxOutputTokens: plan.call.maxOutputTokens,
    }),
    systemPrompts: [factExtractionPrompt(now.toISOString().slice(0, 10))],
    messages,
    stream: false,
  });
  // A call on Host credentials is recorded against the Quota, like a title (ADR 0007).
  if (plan.call.hostModel) {
    const reported = reportedUsageOf(parseModelId(plan.model)?.provider ?? "", result.chunks);
    const usage = messageUsage(reported.usage, {
      promptCharacters: promptCharactersOf(messages),
      parts: [{ type: "text", text: result.text }],
    });
    await recordHostUsage(
      deps,
      "memory",
      { userId, model: plan.model, price: plan.call.hostModel },
      usage,
      reported.cost,
    );
  }
  const json = result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const { facts } = factsReply.parse(JSON.parse(json));
  return facts.map((fact) => fact.trim()).filter((fact) => fact.length > 0);
}

/** The Messages as labelled turns, each cut to `promptChars`. */
function transcriptOf(messages: MessageRow[]): string {
  return messages
    .map(
      (m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.searchText.slice(0, promptChars)}`,
    )
    .join("\n\n");
}
