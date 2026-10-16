import { chat, type ModelMessage } from "@tanstack/ai";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { isKnownModel, parseModelId } from "../../../models/shared/models";
import type { ResolvedEmbeddingModel } from "../../../models/server/embedding-models";
import { loadPath } from "../../../../core/server/chat/message-tree";
import { promptCharactersOf, reportedUsageOf } from "../chat/usage";
import {
  conversation,
  type MessageRow,
  memory,
  userSettings,
} from "../../../../core/server/db/schema";
import type { BotSdkContext } from "../../../../core/server/plugin";
import type { ModelCall } from "../../../models/server/credentials/resolve";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { defineJob } from "../jobs/define";
import type { TurnChange } from "../../shared/memory/changes";
import { publishMemoryUpdated } from "./notice";
import { reembedMemoriesJob } from "./manage";
import {
  factExtractionPrompt,
  forgetMatchPrompt,
  memoryDecisionMessage,
  memoryDecisionPrompt,
} from "./prompt";
import { assistantState } from "../state";

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

/** How many of the most similar Memories each candidate is compared with (ADR 0013). */
const similarCount = 5;

/** What the extract call returns: facts, plus the user's explicit "remember" and "forget" requests. */
const extracted = z.object({
  facts: z.array(z.string()).default([]),
  remember: z.array(z.string()).default([]),
  forget: z.array(z.string()).default([]),
});

/** What the decide call returns: one event per fact, naming the Memory it changes by its number. */
const decision = z.object({
  memory: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      event: z.enum(["ADD", "UPDATE", "DELETE", "NONE"]),
    }),
  ),
});

const forgetMatch = z.object({ ids: z.array(z.string()) });

/** What a Memory job needs to run: its Background Model, the call on it, and the embedding Model. */
type MemoryPlan = {
  model: string;
  call: ModelCall;
  embedding: ResolvedEmbeddingModel;
  /** The Conversation's current Project, or null for a general Conversation (ADR 0013). */
  projectId: string | null;
};

type Tx = Parameters<Parameters<BotSdkContext["db"]["transaction"]>[0]>[0];

/** One decision on a fact: what it does, and the old Memory it changes (none for ADD). */
type Decision = { event: "ADD" | "UPDATE" | "DELETE" | "NONE"; text: string; of?: string };

/**
 * Whether Memory may run for a Run in this Conversation, and the Models it would use (ADR 0013).
 * Off for a Temporary Conversation, when Memory is off for the Host or the user, and with no
 * Background Model (the user's, else the Host's: never the reply's Model) or no embedding
 * Model. `null` when it may not run.
 */
async function memoryPlanOf(
  deps: BotSdkContext,
  userId: string,
  conversationId: string,
): Promise<MemoryPlan | null> {
  if (!assistantState(deps).memory) return null;
  const [row] = await deps.db
    .select({ temporary: conversation.temporary, projectId: conversation.projectId })
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
  const model = settings?.backgroundModel ?? deps.plugin("models").defaultBackgroundModel;
  if (!model || !isKnownModel(model)) return null;
  const call = await deps.plugin("models").resolveModelCall(userId, model);
  if (!call) return null;
  const embedding = await deps.plugin("models").defaultEmbeddingModel(userId);
  if (!embedding) return null;
  return { model, call, embedding, projectId: row.projectId };
}

/** The job that makes Memories from one Run (ADR 0013). Its key is `memory:<replyId>`. */
export const makeMemoriesJob = defineJob<MakeMemoriesPayload>({
  name: "memory.make",
  payload: makeMemoriesPayload,
  run: (payload, { deps }) => makeMemories(payload, deps),
});

/**
 * Queues the job for a Run that ended `complete` or `stopped`, when Memory may run for it. Called
 * from the Run-end hook, fire-and-forget, so a reply never waits for it.
 */
export async function enqueueMemories(
  deps: BotSdkContext,
  payload: MakeMemoriesPayload,
): Promise<void> {
  const plan = await memoryPlanOf(deps, payload.userId, payload.conversationId);
  if (!plan) return;
  // Once per embedding Model, the user's Memories made with another Model are embedded again (#289).
  await assistantState(deps).jobs.enqueue(
    reembedMemoriesJob.name,
    { userId: payload.userId },
    { idempotencyKey: `memory-reembed:${payload.userId}:${plan.embedding.id}` },
  );
  await assistantState(deps).jobs.enqueue(makeMemoriesJob.name, payload, {
    idempotencyKey: `memory:${payload.replyId}`,
  });
}

/**
 * Reads the user's Message of the Run, the reply and the two Messages before the user's Message,
 * then extracts the facts and requests the user made. Each fact is decided against the most similar
 * valid Memories in the same scope, and each "forget" request deletes the Memories it is about; a
 * "remember" request is saved as it is said (ADR 0013). The user's Memory jobs run one at a time,
 * under a Postgres advisory lock. A Message's Memories are never made twice, so a retried job, or a
 * regenerated reply, adds nothing new. Ends quietly, with no error, when the user is over Quota or
 * the Models are gone.
 */
async function makeMemories(payload: MakeMemoriesPayload, deps: BotSdkContext): Promise<void> {
  const { userId, conversationId, replyId } = payload;
  const plan = await memoryPlanOf(deps, userId, conversationId);
  if (!plan) return;
  // Either Model on Host credentials counts against the Quota, so the job ends at once past it.
  if (!(await plan.call.meter.mayRun()).ok || !(await plan.embedding.meter.mayRun()).ok) return;

  const path = await loadPath(deps, conversationId, replyId);
  const reply = path.at(-1);
  const user = path.at(-2);
  if (!reply || reply.id !== replyId || !user || user.role !== "user") return;
  const before = path.slice(Math.max(0, path.length - 4), path.length - 2);
  // What this turn changed, published once the Memories are written (#290).
  const changes: TurnChange[] = [];

  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`memory:${userId}`}, 0))`);
    const [made] = await tx
      .select({ id: memory.id })
      .from(memory)
      .where(eq(memory.sourceMessageId, user.id))
      .limit(1);
    if (made) return;

    const now = deps.clock();
    const extract = await extractMemories(deps, {
      plan,
      transcript: transcriptOf([...before, user, reply]),
      now,
    });
    const scope = { userId, projectId: plan.projectId };
    const write = { userId, plan, tx, now, conversationId, sourceMessageId: user.id, changes };
    for (const request of extract.forget) await forgetMatching(deps, { ...write, scope, request });
    if (extract.remember.length > 0) {
      const ids = await insertMemories(deps, { ...write, texts: extract.remember, origin: "said" });
      ids.forEach((id, i) =>
        changes.push({ kind: "added", memoryId: id, text: extract.remember[i]! }),
      );
    }
    if (extract.facts.length > 0)
      await decideFacts(deps, { ...write, scope, facts: extract.facts });
  });
  if (changes.length > 0) {
    await publishMemoryUpdated(deps, conversationId, {
      type: "memory_updated",
      messageId: replyId,
      changes,
    });
  }
}

/** What every step of the job writes with: the Memories' owner, the transaction, and when. */
type Write = {
  userId: string;
  plan: MemoryPlan;
  tx: Tx;
  now: Date;
  conversationId: string;
  sourceMessageId: string;
  /** Where each change this turn makes is recorded, for the "Memory updated" notice (#290). */
  changes: TurnChange[];
};

/** The scope a Memory is compared within: a Project's, or the general ones (ADR 0013). */
type Scope = { userId: string; projectId: string | null };

/** The valid Memories in `scope` most similar to `vector`, nearest first, with no threshold. */
async function nearestValid(tx: Tx, scope: Scope, vector: number[], limit: number) {
  return tx
    .select({ id: memory.id, text: memory.text })
    .from(memory)
    .innerJoin(conversation, eq(conversation.id, memory.conversationId))
    .where(
      and(
        eq(memory.userId, scope.userId),
        isNull(memory.invalidAt),
        scope.projectId === null
          ? isNull(conversation.projectId)
          : eq(conversation.projectId, scope.projectId),
      ),
    )
    .orderBy(sql`${memory.embedding} <=> ${JSON.stringify(vector)}::vector`)
    .limit(limit);
}

/** The Memories a Background Model call sees, numbered from 0 for the call (ADR 0013). */
const numbered = (rows: Array<{ id: string; text: string }>) =>
  rows.map((row, i) => ({ id: String(i), text: row.text }));

/** Saves each text as a new Memory of `origin`, with its embedding. */
async function insertMemories(
  deps: BotSdkContext,
  {
    texts,
    origin,
    vectors,
    ...write
  }: Write & { texts: string[]; origin: "extracted" | "said"; vectors?: number[][] },
): Promise<string[]> {
  const { userId, plan, tx, now, conversationId, sourceMessageId } = write;
  const embedded =
    vectors ??
    (await deps.plugin("models").embedTexts({ model: plan.embedding, texts, purpose: "document" }));
  const ids = texts.map(() => uuidv7(now.getTime()));
  await tx.insert(memory).values(
    texts.map((text, i) => ({
      id: ids[i]!,
      userId,
      text,
      embedding: embedded[i]!,
      embeddingModel: plan.embedding.id,
      conversationId,
      sourceMessageId,
      origin,
      createdAt: now,
      updatedAt: now,
    })),
  );
  return ids;
}

/**
 * Decides each new fact against the most similar valid Memories in its scope (ADR 0013). With no
 * Memory to compare with, every fact is added with no decide call. Otherwise one decide call over
 * the union of the facts' top matches decides ADD, UPDATE, DELETE or NONE for each fact.
 */
async function decideFacts(
  deps: BotSdkContext,
  { facts, scope, ...write }: Write & { facts: string[]; scope: Scope },
): Promise<void> {
  const { plan, tx, now, changes } = write;
  const vectors = await deps.plugin("models").embedTexts({
    model: plan.embedding,
    texts: facts,
    purpose: "document",
  });
  const pool = new Map<string, { id: string; text: string }>();
  for (const vector of vectors) {
    for (const near of await nearestValid(tx, scope, vector, similarCount)) pool.set(near.id, near);
  }
  const old = [...pool.values()];

  const events: Decision[] =
    old.length === 0
      ? facts.map((text) => ({ event: "ADD", text }))
      : await decideWith(deps, { plan, old, facts });

  const byId = new Map(old.map((row) => [row.id, row]));
  const changed = new Set<string>();
  const writes = events.filter((e) => e.event === "ADD" || e.event === "UPDATE");
  const vectorOf = new Map(facts.map((text, i) => [text, vectors[i]!]));
  const missing = [...new Set(writes.map((e) => e.text))].filter((text) => !vectorOf.has(text));
  if (missing.length > 0) {
    const embedded = await deps.plugin("models").embedTexts({
      model: plan.embedding,
      texts: missing,
      purpose: "document",
    });
    missing.forEach((text, i) => vectorOf.set(text, embedded[i]!));
  }

  for (const event of events) {
    if (event.event === "ADD") {
      const [added] = await insertMemories(deps, {
        ...write,
        texts: [event.text],
        origin: "extracted",
        vectors: [vectorOf.get(event.text)!],
      });
      changes.push({ kind: "added", memoryId: added!, text: event.text });
    }
    if (event.event !== "UPDATE" && event.event !== "DELETE") continue;
    const target = event.of ? byId.get(event.of) : undefined;
    if (!target || changed.has(target.id)) continue;
    changed.add(target.id);
    if (event.event === "UPDATE") {
      const [replacement] = await insertMemories(deps, {
        ...write,
        texts: [event.text],
        origin: "extracted",
        vectors: [vectorOf.get(event.text)!],
      });
      await tx
        .update(memory)
        .set({ invalidAt: now, replacedById: replacement!, updatedAt: now })
        .where(eq(memory.id, target.id));
      changes.push({
        kind: "updated",
        memoryId: replacement!,
        from: target.text,
        text: event.text,
      });
    } else {
      await tx
        .update(memory)
        .set({ invalidAt: now, updatedAt: now })
        .where(eq(memory.id, target.id));
      changes.push({ kind: "forgot", text: target.text });
    }
  }
}

/** The decide call's events, with each one's old Memory's id (for UPDATE, DELETE and NONE). */
async function decideWith(
  deps: BotSdkContext,
  {
    plan,
    old,
    facts,
  }: {
    plan: MemoryPlan;
    old: Array<{ id: string; text: string }>;
    facts: string[];
  },
): Promise<Decision[]> {
  const reply = await askBackground(deps, {
    plan,
    system: memoryDecisionPrompt,
    user: memoryDecisionMessage(numbered(old), facts),
  });
  return parseReply(decision, reply).memory.flatMap(({ id, text, event }): Decision[] => {
    if (event === "ADD") return [{ event, text }];
    const of = old[Number(id)]?.id;
    return of === undefined ? [] : [{ event, text, of }];
  });
}

/**
 * Deletes the Memories a "forget" request is about, found among the most similar in its scope (ADR
 * 0013). The Background Model says which of them the request means; the rest stay.
 */
async function forgetMatching(
  deps: BotSdkContext,
  { request, scope, ...write }: Write & { request: string; scope: Scope },
): Promise<void> {
  const { plan, tx, changes } = write;
  const [vector] = await deps.plugin("models").embedTexts({
    model: plan.embedding,
    texts: [request],
    purpose: "query",
  });
  const near = await nearestValid(tx, scope, vector!, similarCount);
  if (near.length === 0) return;
  const reply = await askBackground(deps, {
    plan,
    system: forgetMatchPrompt,
    user: `Request: ${JSON.stringify(request)}\n\n${JSON.stringify(numbered(near))}`,
  });
  const ids = parseReply(forgetMatch, reply).ids.flatMap((id) => {
    const of = near[Number(id)];
    return of === undefined ? [] : [of.id];
  });
  if (ids.length === 0) return;
  const forgotten = await tx
    .delete(memory)
    .where(inArray(memory.id, ids))
    .returning({ text: memory.text });
  for (const row of forgotten) changes.push({ kind: "forgot", text: row.text });
}

/** The facts and requests the Background Model reads in the transcript (ADR 0013). */
async function extractMemories(
  deps: BotSdkContext,
  { plan, transcript, now }: { plan: MemoryPlan; transcript: string; now: Date },
): Promise<z.infer<typeof extracted>> {
  const reply = await askBackground(deps, {
    plan,
    system: factExtractionPrompt(now.toISOString().slice(0, 10)),
    user: transcript,
  });
  const parsed = parseReply(extracted, reply);
  const clean = (texts: string[]) =>
    texts.map((text) => text.trim()).filter((text) => text.length > 0);
  return {
    facts: clean(parsed.facts),
    remember: clean(parsed.remember),
    forget: clean(parsed.forget),
  };
}

/** One call on the Background Model, recorded against the Quota when it is on Host credentials (ADR 0007). */
async function askBackground(
  deps: BotSdkContext,
  { plan, system, user }: { plan: MemoryPlan; system: string; user: string },
): Promise<string> {
  const messages: ModelMessage[] = [{ role: "user", content: user }];
  const result = await chat({
    adapter: deps.plugin("models").adapterFor(plan.model, plan.call.credentials, {
      maxOutputTokens: plan.call.maxOutputTokens,
    }),
    systemPrompts: [system],
    messages,
    stream: false,
  });
  const reported = reportedUsageOf(parseModelId(plan.model)?.provider ?? "", result.chunks);
  await plan.call.meter.record({
    kind: "memory",
    usage: deps.plugin("models").messageUsage(reported.usage, {
      promptCharacters: promptCharactersOf(messages),
      parts: [{ type: "text", text: result.text }],
    }),
    reportedCost: reported.cost,
  });
  return result.text;
}

/** Parses a Background Model reply as JSON and validates it with Zod, after stripping code fences. */
function parseReply<T extends z.ZodType>(schema: T, reply: string): z.infer<T> {
  const json = reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return schema.parse(JSON.parse(json));
}

/** The Messages as labelled turns, each cut to `promptChars`. */
function transcriptOf(messages: MessageRow[]): string {
  return messages
    .map(
      (m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.searchText.slice(0, promptChars)}`,
    )
    .join("\n\n");
}
