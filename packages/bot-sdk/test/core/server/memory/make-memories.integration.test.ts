import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createHookEmitter } from "../../../../core/server/chat/hooks";
import { conversationChannel } from "../../../../plugins/assistant/server/memory/notice";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  conversation,
  message,
  project,
  job,
  memory,
  userSettings,
  usage,
} from "../../../../core/server/db/schema";
import type { HostProvider } from "../../../../plugins/assistant/server/deps";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, runError, text } from "../../../support/fake-adapter";
import { drainJobs } from "../../../support/jobs";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const replyModel = "anthropic:claude-sonnet-5-5";
const backgroundModel = "anthropic:claude-haiku-4-5";
const userText = "I'm vegetarian, and I live in Pune.";
const today = new Date("2026-10-14T10:00:00Z");

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

const hostOpenAI: HostProvider = {
  provider: "openai",
  credentials: { apiKey: "sk-host-openai" },
  models: [
    {
      modelId: "gpt-5.4-mini",
      maxOutputTokens: 1_000,
      inputUsdPerMillion: 0.25,
      outputUsdPerMillion: 2,
    },
  ],
  embeddingModels: [{ model: "text-embedding-3-small", pricePerMillionTokensUsd: 0.02 }],
};

/**
 * A signed-in user with an Anthropic key for the reply, and an OpenAI key for embeddings unless
 * `ownEmbeddingKey` is false. The reply and the Background Model get their own fake adapters. The
 * Conversation has a title, so titling never calls the Background Model.
 */
async function setup({
  reply = [round(text("Noted: no meat in your recipes."))],
  replyManual = false,
  facts = [round(text('{"facts": ["Is vegetarian", "Lives in Pune"]}'))],
  ownEmbeddingKey = true,
  conversation: fields = {},
  deps: overrides = {},
}: {
  reply?: Rounds;
  replyManual?: boolean;
  facts?: Rounds;
  ownEmbeddingKey?: boolean;
  conversation?: Partial<typeof conversation.$inferInsert>;
  deps?: TestDepsOverrides;
} = {}) {
  const user = await insertUser();
  const replyFake = createFakeAdapter({ rounds: reply, manual: replyManual });
  const memoryFake = createFakeAdapter({ rounds: facts });
  const deps = createTestSdk({
    defaultBackgroundModel: backgroundModel,
    clock: () => today,
    adapterFor: (model) => (model === replyModel ? replyFake.adapter : memoryFake.adapter),
    ...overrides,
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  if (ownEmbeddingKey) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "sk-openai-own-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const conv = await insertConversation(user, { model: replyModel, title: "Chat", ...fields });
  const post = (command: { parentId?: string | null; conversationId?: string } = {}) =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: userText,
            attachmentIds: [],
            model: replyModel,
            webSearch: false,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
  const send = async (command: { parentId?: string | null; conversationId?: string } = {}) =>
    (await post(command)).text();
  return { user, deps, conv, post, send, memoryFake };
}

/** The Memory job a Run queues is fire-and-forget, so this waits for it, then runs it. */
async function drainMemory(deps: TestDeps) {
  await vi.waitFor(async () => expect(await drainJobs({ deps })).toBeGreaterThan(0));
}

/** For a test where no Memory job should run: lets the Run's enqueue settle, then checks none ran. */
async function expectNoMemoryJob(deps: TestDeps) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await drainJobs({ deps })).toBe(0);
}

const memoriesOf = (userId: string) =>
  getTestDb().select().from(memory).where(eq(memory.userId, userId));

async function messageOf(conversationId: string, role: "user" | "assistant") {
  const [row] = await getTestDb()
    .select()
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.role, role)));
  if (!row) throw new Error(`No ${role} Message in the Conversation`);
  return row;
}

describe("making Memories after a Run", () => {
  it("adds a Memory per fact the user stated, from the user's Message, with its embedding", async () => {
    const { user, deps, conv, send, memoryFake } = await setup();

    await send();
    await drainMemory(deps);

    const userMessage = await messageOf(conv.id, "user");
    const rows = await memoriesOf(user.id);
    expect(rows.map((row) => row.text).sort()).toEqual(["Is vegetarian", "Lives in Pune"]);
    for (const row of rows) {
      expect(row).toMatchObject({
        origin: "extracted",
        conversationId: conv.id,
        sourceMessageId: userMessage.id,
        embeddingModel: "openai:text-embedding-3-small",
        invalidAt: null,
        replacedById: null,
        createdAt: today,
      });
      expect(row.embedding).toHaveLength(1536);
    }
    // The extract call reads the user's words and the reply as labelled turns, with today's date.
    const call = memoryFake.calls[0]!;
    expect(JSON.stringify(call.messages)).toContain(`User: ${userText}`);
    expect(JSON.stringify(call.messages)).toContain("Assistant: Noted: no meat in your recipes.");
    expect(JSON.stringify(call.systemPrompts)).toContain("Today's date is 2026-10-14");
    expect(JSON.stringify(call.systemPrompts)).not.toContain("publicly available sources");
  });

  it("reads the two Messages before the user's on the Branch, as context", async () => {
    const { user, deps, conv, send, memoryFake } = await setup();
    const earlierUser = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "I'm learning Japanese.",
    });
    await insertMessage({
      conversationId: conv.id,
      parentId: earlierUser.id,
      role: "assistant",
      text: "Great, what level?",
      active: true,
    });

    await send({ parentId: (await messageOf(conv.id, "assistant")).id });
    await drainMemory(deps);

    expect(JSON.stringify(memoryFake.calls[0]!.messages)).toContain("I'm learning Japanese.");
    expect(await memoriesOf(user.id)).toHaveLength(2);
  });

  it("makes Memories from a Run that was stopped", async () => {
    const { user, deps, conv, post } = await setup({ replyManual: true });

    // The reply waits on a release that never comes, so Stop ends it as `stopped`.
    const posting = await post();
    await vi.waitFor(async () => expect(await messageOf(conv.id, "assistant")).toBeDefined());
    await chatRpc({ user, deps }).chat.stop({
      messageId: (await messageOf(conv.id, "assistant")).id,
    });
    await posting.text();

    await drainMemory(deps);
    expect((await memoriesOf(user.id)).map((row) => row.text)).toContain("Is vegetarian");
  });

  it("makes no job for a Run whose reply was hidden by moderation", async () => {
    // The Host's output check hides every reply, so the Run ends `complete` with a hidden reply.
    const hooks = createHookEmitter(
      {
        moderate: (check) =>
          check.phase === "output" ? { allow: false, reason: "Policy" } : { allow: true },
      },
      { error: () => {} },
    );
    const { user, deps, send } = await setup({ deps: { hooks } });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job for a Run that errored", async () => {
    const { user, deps, send } = await setup({ reply: [round(runError("Provider down"))] });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job in a Temporary Conversation", async () => {
    const { user, deps, send } = await setup({ conversation: { temporary: true } });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job when the user has Memory off", async () => {
    const { user, deps, send } = await setup();
    await getTestDb().insert(userSettings).values({ userId: user.id, memoryEnabled: false });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job when the Host has Memory off", async () => {
    const { user, deps, send } = await setup({ deps: { memory: false } });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job with no Background Model and no Host default, and never uses the reply's Model", async () => {
    const { user, deps, send, memoryFake } = await setup({
      deps: { defaultBackgroundModel: null },
    });

    await send();

    await expectNoMemoryJob(deps);
    expect(memoryFake.calls).toEqual([]);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("makes no job with no embedding Model", async () => {
    const { user, deps, send } = await setup({ ownEmbeddingKey: false });

    await send();

    await expectNoMemoryJob(deps);
    expect(await memoriesOf(user.id)).toEqual([]);
  });

  it("adds nothing over Quota, and records the calls on Host credentials within it", async () => {
    const hosted = { hostProviders: [hostOpenAI], defaultBackgroundModel: "openai:gpt-5.4-mini" };

    const over = await setup({
      ownEmbeddingKey: false,
      deps: { ...hosted, getQuota: async () => ({ budgetUsd: 0, window: "day" }) },
    });
    await over.send();
    // The job runs and ends quietly: no call on the Background Model, no Memory, and no error.
    await drainMemory(over.deps);
    expect(over.memoryFake.calls).toEqual([]);
    expect(await memoriesOf(over.user.id)).toEqual([]);
    const jobs = await getTestDb().select().from(job).where(eq(job.name, "memory.make"));
    expect(jobs.map((row) => row.status)).toEqual(["succeeded"]);

    const within = await setup({
      ownEmbeddingKey: false,
      deps: { ...hosted, getQuota: async () => ({ budgetUsd: 10, window: "day" }) },
    });
    await within.send();
    await drainMemory(within.deps);

    expect(await memoriesOf(within.user.id)).toHaveLength(2);
    const kinds = (await getTestDb().select().from(usage).where(eq(usage.userId, within.user.id)))
      .map((row) => row.kind)
      .sort();
    expect(kinds).toEqual(["embedding", "memory"]);
  });

  it("writes Memory on the user's linked ChatGPT plan when the Background Model is a plan Model (ADR 0023)", async () => {
    const planModel = "openai:gpt-6.1-sol";
    const replyFake = createFakeAdapter({ rounds: [round(text("Noted."))] });
    const memoryFake = createFakeAdapter({
      rounds: [round(text('{"facts": ["Is vegetarian", "Lives in Pune"]}'))],
    });
    const memoryCalls: Array<Record<string, string>> = [];
    const { user, send, deps } = await setup({
      ownEmbeddingKey: false,
      deps: {
        hostProviders: [hostOpenAI],
        defaultBackgroundModel: planModel,
        linkedCredentials: async () => ({ apiKey: "chatgpt-access-token" }),
        adapterFor: (model, credentials) => {
          if (model === replyModel) return replyFake.adapter;
          memoryCalls.push(credentials);
          return memoryFake.adapter;
        },
        getQuota: async () => ({ budgetUsd: 10, window: "day" }),
      },
    });

    await send();
    await drainMemory(deps);

    expect(await memoriesOf(user.id)).toHaveLength(2);
    expect(memoryCalls).toEqual([{ apiKey: "chatgpt-access-token" }]);
    // The embeddings ran on the Host's credentials; the Background Model's call was the user's.
    const kinds = (await getTestDb().select().from(usage).where(eq(usage.userId, user.id))).map(
      (row) => row.kind,
    );
    expect(kinds).toEqual(["embedding"]);
  });

  it("adds nothing when the same user Message is processed again", async () => {
    const { user, deps, conv, send, memoryFake } = await setup();
    await send();
    await drainMemory(deps);
    const replyId = (await messageOf(conv.id, "assistant")).id;

    // A replayed job, or a regenerated reply, on the same user Message.
    const key = `memory-replay:${replyId}`;
    await deps
      .plugin("runner")
      .enqueue(
        "memory.make",
        { userId: user.id, conversationId: conv.id, replyId },
        { idempotencyKey: key },
      );
    await drainMemory(deps);

    expect(await memoriesOf(user.id)).toHaveLength(2);
    expect(memoryFake.calls).toHaveLength(1);
    const [replayed] = await getTestDb().select().from(job).where(eq(job.idempotencyKey, key));
    expect(replayed?.status).toBe("succeeded");
  });
});

/** A Background Model reply with this JSON. */
const jsonRound = (json: unknown) => round(text(JSON.stringify(json)));

/**
 * The id the job's prompt gives each Memory, by its text. The decide and forget calls list the
 * Memories as `{"id":"0","text":"..."}`, so a scripted reply can name them by their text.
 */
function idsIn(options: { messages: Array<{ content: unknown }> }): Map<string, string> {
  const content = options.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
  return new Map(
    [...content.matchAll(/\{"id":"(\d+)","text":"([^"]*)"\}/g)].map((m) => [m[2]!, m[1]!]),
  );
}

type Event = { event: "ADD" | "UPDATE" | "DELETE" | "NONE"; text: string; of?: string };

/** A decide reply: each event names the Memory it is about by its text (an ADD has none). */
const decideRound =
  (...events: Event[]) =>
  (options: { messages: Array<{ content: unknown }> }) => {
    const ids = idsIn(options);
    return jsonRound({
      memory: events.map(({ event, text: value, of }) => ({
        id: of === undefined ? "new" : ids.get(of),
        text: value,
        event,
      })),
    });
  };

/** A forget reply: the ids of the Memories the request is about. */
const forgetRound = (about: string) => (options: { messages: Array<{ content: unknown }> }) =>
  jsonRound({ ids: [idsIn(options).get(about)] });

const twoReplies: Rounds = [round(text("Noted.")), round(text("Noted again."))];

describe("deciding against existing Memories", () => {
  it("replaces a changed fact: the old Memory is kept invalid and linked to the new one", async () => {
    const { user, deps, conv, send } = await setup({
      reply: twoReplies,
      facts: [
        jsonRound({ facts: ["Is vegetarian", "Lives in Pune"] }),
        jsonRound({ facts: ["Eats fish"] }),
        decideRound(
          { event: "UPDATE", text: "Eats fish", of: "Is vegetarian" },
          { event: "NONE", text: "Lives in Pune", of: "Lives in Pune" },
        ),
      ],
    });
    await send();
    await drainMemory(deps);
    await send({ parentId: (await messageOf(conv.id, "assistant")).id });
    await drainMemory(deps);

    const rows = await memoriesOf(user.id);
    const replacement = rows.find((row) => row.text === "Eats fish");
    const old = rows.find((row) => row.text === "Is vegetarian");
    expect(replacement).toMatchObject({ origin: "extracted", invalidAt: null });
    expect(old?.replacedById).toBe(replacement?.id);
    expect(old?.invalidAt?.getTime()).toBe(today.getTime());
    expect(rows.find((row) => row.text === "Lives in Pune")?.invalidAt).toBeNull();
  });

  it("DELETE marks the old Memory invalid, with no new Memory", async () => {
    const { user, deps, conv, send } = await setup({
      reply: twoReplies,
      facts: [
        jsonRound({ facts: ["Is vegetarian", "Lives in Pune"] }),
        jsonRound({ facts: ["Moved away from Pune"] }),
        decideRound({ event: "DELETE", text: "Lives in Pune", of: "Lives in Pune" }),
      ],
    });
    await send();
    await drainMemory(deps);
    await send({ parentId: (await messageOf(conv.id, "assistant")).id });
    await drainMemory(deps);

    const rows = await memoriesOf(user.id);
    expect(rows).toHaveLength(2);
    const deleted = rows.find((row) => row.text === "Lives in Pune");
    expect(deleted?.invalidAt?.getTime()).toBe(today.getTime());
    expect(deleted?.replacedById).toBeNull();
    expect(rows.find((row) => row.text === "Is vegetarian")?.invalidAt).toBeNull();
  });

  it("NONE changes nothing", async () => {
    const { user, deps, conv, send } = await setup({
      reply: twoReplies,
      facts: [
        jsonRound({ facts: ["Is vegetarian", "Lives in Pune"] }),
        jsonRound({ facts: ["Is vegetarian"] }),
        decideRound({ event: "NONE", text: "Is vegetarian", of: "Is vegetarian" }),
      ],
    });
    await send();
    await drainMemory(deps);
    await send({ parentId: (await messageOf(conv.id, "assistant")).id });
    await drainMemory(deps);

    const rows = await memoriesOf(user.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.invalidAt === null)).toBe(true);
  });

  it("ADD inserts a new Memory and leaves the others valid", async () => {
    const { user, deps, conv, send } = await setup({
      reply: twoReplies,
      facts: [
        jsonRound({ facts: ["Is vegetarian", "Lives in Pune"] }),
        jsonRound({ facts: ["Works as an engineer"] }),
        decideRound({ event: "ADD", text: "Works as an engineer" }),
      ],
    });
    await send();
    await drainMemory(deps);
    await send({ parentId: (await messageOf(conv.id, "assistant")).id });
    await drainMemory(deps);

    const rows = await memoriesOf(user.id);
    expect(rows.map((row) => row.text).sort()).toEqual([
      "Is vegetarian",
      "Lives in Pune",
      "Works as an engineer",
    ]);
    expect(rows.every((row) => row.invalidAt === null)).toBe(true);
  });

  it("shows the decide call at most the 5 most similar Memories", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => `Fact ${i + 1}`);
    const { deps, conv, send, memoryFake } = await setup({
      reply: twoReplies,
      facts: [jsonRound({ facts: seven }), jsonRound({ facts: ["Fact eight"] }), decideRound()],
    });
    await send();
    await drainMemory(deps);
    await send({ parentId: (await messageOf(conv.id, "assistant")).id });
    await drainMemory(deps);

    expect(memoryFake.calls).toHaveLength(3);
    expect(idsIn(memoryFake.calls[2]!).size).toBe(5);
  });

  it("saves a 'remember' request as said, with no decide call, and gives the extract call today's date", async () => {
    const { user, deps, memoryFake, send } = await setup({
      facts: [jsonRound({ facts: [], remember: ["Likes jazz"] })],
    });

    await send();
    await drainMemory(deps);

    expect(await memoriesOf(user.id)).toMatchObject([
      { text: "Likes jazz", origin: "said", invalidAt: null },
    ]);
    expect(memoryFake.calls).toHaveLength(1);
    expect(JSON.stringify(memoryFake.calls[0])).toContain("2026-10-14");
  });

  it("hard-deletes the Memory a 'forget' request is about", async () => {
    const { user, deps, conv, send } = await setup({
      reply: twoReplies,
      facts: [
        jsonRound({ facts: ["Lives in Pune", "Is vegetarian"] }),
        jsonRound({ facts: [], forget: ["Lives in Pune"] }),
        forgetRound("Lives in Pune"),
      ],
    });
    await send();
    await drainMemory(deps);
    await send({ parentId: (await messageOf(conv.id, "assistant")).id });
    await drainMemory(deps);

    expect((await memoriesOf(user.id)).map((row) => row.text)).toEqual(["Is vegetarian"]);
  });

  it("never invalidates a general Memory from a Project's Conversation", async () => {
    const { user, deps, send, memoryFake } = await setup({
      reply: twoReplies,
      facts: [jsonRound({ facts: ["Is vegetarian"] }), jsonRound({ facts: ["Is vegetarian"] })],
    });
    await send();
    await drainMemory(deps);

    const projectId = randomUUID();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Thesis" });
    const inProject = await insertConversation(user, { projectId, title: "Thesis chat" });
    await send({ conversationId: inProject.id });
    await drainMemory(deps);

    // The general fact's pool is empty in the Project's scope, so it is added with no decide call.
    expect(memoryFake.calls).toHaveLength(2);
    const rows = await memoriesOf(user.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.invalidAt === null)).toBe(true);
    expect(rows.find((row) => row.conversationId === inProject.id)).toBeDefined();
  });
});

/** The next `data:` event a live stream sends, parsed. */
async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The stream ended before an event");
    buffer += decoder.decode(value, { stream: true });
    const match = /data: (.*)\n\n/.exec(buffer);
    if (match) return JSON.parse(match[1]!);
  }
}

describe("telling the user what a turn changed (#290)", () => {
  it("publishes memory_updated with the turn's changes on the Conversation's channel", async () => {
    const { user, deps, conv, send } = await setup();
    const published: unknown[] = [];
    const unsubscribe = await deps.pubsub.subscribe(conversationChannel(conv.id), (message) =>
      published.push(JSON.parse(message)),
    );

    await send();
    await drainMemory(deps);

    const reply = await messageOf(conv.id, "assistant");
    expect(published).toEqual([
      {
        type: "memory_updated",
        messageId: reply.id,
        changes: [
          { kind: "added", memoryId: expect.any(String), text: "Is vegetarian" },
          { kind: "added", memoryId: expect.any(String), text: "Lives in Pune" },
        ],
      },
    ]);
    await unsubscribe();
    expect(await memoriesOf(user.id)).toHaveLength(2);
  });

  it("publishes nothing when the turn changed no Memory", async () => {
    const { deps, conv, send } = await setup({ facts: [jsonRound({ facts: [] })] });
    const published: string[] = [];
    await deps.pubsub.subscribe(conversationChannel(conv.id), (message) => published.push(message));

    await send();
    await drainMemory(deps);

    expect(published).toEqual([]);
  });

  it("streams the event to the owner's open page as the job finishes", async () => {
    const { user, deps, conv, send } = await setup();
    const response = await sendAs(
      new Request(`http://localhost/api/chat/events?conversationId=${conv.id}`),
      user,
      deps,
    );
    const reader = response.body!.getReader();

    await send();
    await drainMemory(deps);

    const reply = await messageOf(conv.id, "assistant");
    expect(await nextEvent(reader)).toMatchObject({
      type: "memory_updated",
      messageId: reply.id,
      changes: [
        { kind: "added", text: "Is vegetarian" },
        { kind: "added", text: "Lives in Pune" },
      ],
    });
    await reader.cancel();
  });

  it("refuses the live stream to anyone but the Conversation's owner", async () => {
    const { deps, conv } = await setup();
    const stranger = await insertUser();

    const response = await sendAs(
      new Request(`http://localhost/api/chat/events?conversationId=${conv.id}`),
      stranger,
      deps,
    );

    expect(response.status).toBe(404);
  });

  it("derives the changes of a reloaded reply from its turn's Memories, updates from the old text", async () => {
    const { user, deps, conv, send } = await setup({
      reply: twoReplies,
      facts: [
        jsonRound({ facts: ["Is vegetarian", "Lives in Pune"] }),
        jsonRound({ facts: ["Eats fish"] }),
        decideRound({ event: "UPDATE", text: "Eats fish", of: "Is vegetarian" }),
      ],
    });
    await send();
    await drainMemory(deps);
    await send({ parentId: (await messageOf(conv.id, "assistant")).id });
    await drainMemory(deps);

    const { messages } = await chatRpc({ user, deps }).conversation.get({ id: conv.id });
    const replies = messages.filter((m) => m.role === "assistant");
    // Both facts share the job's clock, so their order here is not defined; the set is.
    expect(replies[0]?.memoryChanges).toHaveLength(2);
    expect(replies[0]?.memoryChanges).toEqual(
      expect.arrayContaining([
        { kind: "added", memoryId: expect.any(String), text: "Is vegetarian" },
        { kind: "added", memoryId: expect.any(String), text: "Lives in Pune" },
      ]),
    );
    expect(replies[1]?.memoryChanges).toEqual([
      { kind: "updated", memoryId: expect.any(String), from: "Is vegetarian", text: "Eats fish" },
    ]);
  });
});
