import { storedParts, type StoredPart } from "../../../../core/shared/message-parts";
import { conversation, message } from "../../../../core/server/db/schema";
import { toolDefinition } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { HostToolContext } from "../../../../core/server/chat/host-tools";
import { reapStaleRuns, stopRun } from "../../../../core/server/chat/run";
import { deleteUserData } from "../../../../core/server/delete-user";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import type { HostProvider } from "../../../../core/server/deps";
import { fakeImageAdapter } from "../../../../plugins/models/server/fake-image-adapter";
import { citationPrompt } from "../../../../core/shared/chat/citations";
import { knowledgePromptOf } from "../../../../core/shared/chat/knowledge-search";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestSdk, type TestDepsOverrides, type TestDeps } from "../../../support/deps";
import {
  createFakeAdapter,
  type FakeAdapter,
  round,
  text,
  toolCall,
} from "../../../support/fake-adapter";
import { createFakeSearchClient } from "../../../support/fake-search-client";
import { drainJobs } from "../../../support/jobs";
import { chatRpc, sendAs } from "../../../support/sdk";
import { insertUser, type TestUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";
const basePath = "http://localhost/api/chat";

type Runs = Array<{ to: string; body: string }>;

/** A Host tool that needs Approval. `runs` records each time it really ran. */
function sendMail(runs: Runs) {
  return toolDefinition({
    name: "send_mail",
    description: "Sends an email.",
    inputSchema: z.object({ to: z.string(), body: z.string() }),
    needsApproval: true,
  }).server<HostToolContext>(async (args) => {
    runs.push(args);
    return { sent: true, to: args.to };
  });
}

const mailCall = (id: string, input = { to: "a@b.c", body: "Hi" }) =>
  toolCall({ id, name: "send_mail", input });

const awaitingCall = (toolCallId: string, args = { to: "a@b.c", body: "Hi" }): StoredPart =>
  ({
    type: "tool_call",
    toolCallId,
    name: "send_mail",
    source: "host",
    args,
    state: "awaiting_approval",
  }) as StoredPart;

/** A signed-in user with Anthropic credentials, a fake adapter playing `rounds`, and one Conversation. */
async function setup({
  rounds,
  runs = [],
  manual = false,
  deps: overrides = {},
}: {
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"];
  runs?: Runs;
  manual?: boolean;
  deps?: TestDepsOverrides;
}) {
  const user: TestUser = await insertUser();
  const fake = createFakeAdapter({ rounds, manual });
  const deps = createTestSdk({
    adapterFor: () => fake.adapter,
    tools: [sendMail(runs)],
    ...overrides,
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  // Titled, so a complete run doesn't call the adapter again to title it (#26).
  const conv = await insertConversation(user, { title: "Approval" });
  const send = (command: { text?: string; parentId?: string | null; webSearch?: boolean } = {}) =>
    sendAs(
      new Request(`${basePath}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "Email a@b.c",
            attachmentIds: [],
            model: anthropicModel,
            webSearch: false,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
  /** Decides the waiting call of `messageId` and resolves once its new Run has ended. */
  const decide = async (messageId: string, approved: boolean) => {
    await chatRpc({ user, deps }).chat.decide({ messageId, approved });
    return join(messageId, user, deps);
  };
  return { user, deps, fake, conv, send, decide };
}

/** Joins a Message's Run from its log, and reads the log until it closes. */
async function join(messageId: string, user: TestUser, deps: TestDeps) {
  const response = await sendAs(
    new Request(`${basePath}/run?runId=${messageId}`, { method: "GET" }),
    user,
    deps,
  );
  return response.text();
}

async function repliesOf(deps: TestDeps, conversationId: string) {
  const rows = await deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.filter((row) => row.role === "assistant");
}

const replyOf = async (deps: TestDeps, conversationId: string) =>
  (await repliesOf(deps, conversationId)).at(-1)!;

describe("a Host tool that needs Approval", () => {
  it("ends the Run at the call: the reply waits with the full call, and the tool does not run", async () => {
    const runs: Runs = [];
    const { deps, conv, send } = await setup({
      rounds: [round(mailCall("call-1"))],
      runs,
    });

    await (await send()).text();

    expect(runs).toEqual([]);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "awaiting_approval",
      parts: storedParts([awaitingCall("call-1")]),
    });
  });

  it("approve starts a new Run on the same Message: the tool runs and the reply completes", async () => {
    const runs: Runs = [];
    const { deps, conv, fake, send, decide } = await setup({
      rounds: [round(mailCall("call-1")), round(text("Sent."))],
      runs,
    });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);

    await decide(reply.id, true);

    expect(runs).toEqual([{ to: "a@b.c", body: "Hi" }]);
    expect(fake.calls[1]!.messages.some((m) => m.role === "tool")).toBe(true);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      id: reply.id,
      status: "complete",
      parts: storedParts([
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "send_mail",
          source: "host",
          args: { to: "a@b.c", body: "Hi" },
          result: { sent: true, to: "a@b.c" },
          state: "done",
        },
        { type: "text", text: "Sent." },
      ]),
    });
  });

  it("the joined stream of the resumed Run ends with RUN_FINISHED, as the browser needs to stop waiting", async () => {
    const { deps, conv, send, decide } = await setup({
      rounds: [round(mailCall("call-1")), round(text("Sent."))],
      runs: [],
    });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);

    const joined = await decide(reply.id, true);

    const events = joined.split("\n").filter((line) => line.startsWith("data:"));
    expect(events.at(-1)).toContain("RUN_FINISHED");
    expect(events.some((line) => line.includes("RUN_ERROR"))).toBe(false);
  });

  it("deny never runs the tool: the Model gets a denied result, the call is denied, and the reply completes", async () => {
    const runs: Runs = [];
    const { deps, conv, fake, send, decide } = await setup({
      rounds: [round(mailCall("call-1")), round(text("Okay, not sent."))],
      runs,
    });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);

    await decide(reply.id, false);

    expect(runs).toEqual([]);
    expect(fake.calls[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      content: expect.stringContaining("declined"),
    });
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "send_mail",
          source: "host",
          args: { to: "a@b.c", body: "Hi" },
          result: { error: "User declined tool execution" },
          state: "denied",
        },
        { type: "text", text: "Okay, not sent." },
      ]),
    });
  });

  it("a reply that asks for the tool twice asks twice", async () => {
    const runs: Runs = [];
    const { deps, conv, send, decide } = await setup({
      rounds: [
        round(mailCall("call-1")),
        round(mailCall("call-2", { to: "x@y.z", body: "Again" })),
        round(text("Done.")),
      ],
      runs,
    });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);

    await decide(reply.id, true);

    expect(await replyOf(deps, conv.id)).toMatchObject({
      id: reply.id,
      status: "awaiting_approval",
      parts: storedParts([
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "send_mail",
          source: "host",
          args: { to: "a@b.c", body: "Hi" },
          result: { sent: true, to: "a@b.c" },
          state: "done",
        },
        awaitingCall("call-2", { to: "x@y.z", body: "Again" }),
      ]),
    });

    await decide(reply.id, true);

    expect(runs).toHaveLength(2);
    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "complete" });
  });

  it("reloading the Conversation finds the waiting call", async () => {
    const { user, deps, conv, send } = await setup({ rounds: [round(mailCall("call-1"))] });
    await (await send()).text();

    const fresh = await chatRpc({ user, deps }).conversation.get({ id: conv.id });

    expect(fresh.messages.at(-1)).toMatchObject({ status: "awaiting_approval" });
  });

  it("the reaper and stop() leave a waiting Message alone, however old it is", async () => {
    const { deps, conv, send } = await setup({ rounds: [round(mailCall("call-1"))] });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);

    await reapStaleRuns(deps, new Date(Date.now() + 365 * 24 * 60 * 60_000));
    await stopRun(deps, reply.id);

    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "awaiting_approval",
      error: null,
    });
  });

  it("refuses a decision on a Message that is not waiting, and on another user's", async () => {
    const { user, deps, conv, send } = await setup({
      rounds: [round(text("Hello."))],
    });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);
    const stranger = await insertUser();

    await expect(
      chatRpc({ user, deps }).chat.decide({ messageId: reply.id, approved: true }),
    ).rejects.toThrow();
    await expect(
      chatRpc({ user: stranger, deps }).chat.decide({ messageId: reply.id, approved: true }),
    ).rejects.toThrow();
  });

  it("refuses a send that would continue a reply still waiting for its call", async () => {
    const { deps, conv, send } = await setup({ rounds: [round(mailCall("call-1"))] });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);

    const response = await send({ parentId: reply.id, text: "Keep going" });

    expect(response.status).toBe(409);
  });

  it("Stop on a waiting reply counts as a denial: the tool never runs and the reply completes", async () => {
    const runs: Runs = [];
    const { user, deps, conv, fake, send } = await setup({
      rounds: [round(mailCall("call-1")), round(text("Stopped."))],
      runs,
    });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);

    await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });
    await join(reply.id, user, deps);

    expect(runs).toEqual([]);
    expect(fake.calls[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      content: expect.stringContaining("declined"),
    });
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        expect.objectContaining({ toolCallId: "call-1", state: "denied" }),
        { type: "text", text: "Stopped." },
      ]),
    });
  });

  it("a resumed Run can be stopped, and a stop ends it as stopped", async () => {
    const { user, deps, conv, fake, send, decide } = await setup({
      rounds: [round(mailCall("call-1")), round(text("Sent."))],
      manual: true,
    });
    const response = await send();
    await fake.release(5);
    await response.text();
    const reply = await replyOf(deps, conv.id);
    await expect.poll(async () => (await replyOf(deps, conv.id)).status).toBe("awaiting_approval");

    const resumed = decide(reply.id, true);
    await fake.release(1);
    await expect
      .poll(async () => (await replyOf(deps, conv.id)).status, { interval: 10 })
      .toBe("streaming");
    await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });
    await resumed;

    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "stopped" });
  });
});

/** A second Host tool that needs Approval, to show that an allowance covers one tool only. */
const postNote = toolDefinition({
  name: "post_note",
  description: "Posts a note.",
  inputSchema: z.object({ note: z.string() }),
  needsApproval: true,
}).server<HostToolContext>(async (args) => ({ posted: args.note }));

/** Answers a waiting call with "allow this tool for this Conversation" and joins the new Run. */
async function decideAllowing(user: TestUser, deps: TestDeps, messageId: string) {
  await chatRpc({ user, deps }).chat.decide({
    messageId,
    approved: true,
    allowForConversation: true,
  });
  return join(messageId, user, deps);
}

/** Sends a Message to another Conversation of the same user. */
const sendIn = (user: TestUser, deps: TestDeps, conversationId: string) =>
  sendAs(
    new Request(`${basePath}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        forwardedProps: {
          conversationId,
          parentId: null,
          text: "Email again",
          attachmentIds: [],
          model: anthropicModel,
          webSearch: false,
        },
      }),
    }),
    user,
    deps,
  );

describe("Allow for this Conversation", () => {
  it("runs the waiting call, and a later call to the same tool in that Conversation runs without waiting", async () => {
    const runs: Runs = [];
    const { user, deps, conv, send } = await setup({
      rounds: [
        round(mailCall("call-1")),
        round(text("Sent.")),
        round(mailCall("call-2", { to: "x@y.z", body: "Again" })),
        round(text("Done.")),
      ],
      runs,
    });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);

    await decideAllowing(user, deps, reply.id);

    expect(runs).toEqual([{ to: "a@b.c", body: "Hi" }]);
    expect(await replyOf(deps, conv.id)).toMatchObject({ id: reply.id, status: "complete" });

    await (await send({ text: "Again" })).text();

    expect(runs).toHaveLength(2);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        expect.objectContaining({ toolCallId: "call-2", state: "done" }),
        { type: "text", text: "Done." },
      ]),
    });
  });

  it("a call to the same tool in another Conversation of the same user still waits", async () => {
    const runs: Runs = [];
    const { user, deps, conv, send } = await setup({
      rounds: [round(mailCall("call-1")), round(text("Sent.")), round(mailCall("call-2"))],
      runs,
    });
    await (await send()).text();
    await decideAllowing(user, deps, (await replyOf(deps, conv.id)).id);

    const other = await insertConversation(user, { title: "Other" });
    await (await sendIn(user, deps, other.id)).text();

    expect(await replyOf(deps, other.id)).toMatchObject({ status: "awaiting_approval" });
    expect(runs).toHaveLength(1);
  });

  it("a different tool in the same Conversation still waits", async () => {
    const runs: Runs = [];
    const { user, deps, conv, send } = await setup({
      rounds: [
        round(mailCall("call-1")),
        round(text("Sent.")),
        round(toolCall({ id: "note-1", name: "post_note", input: { note: "Hi" } })),
      ],
      runs,
      deps: { tools: [sendMail(runs), postNote] },
    });
    await (await send()).text();
    await decideAllowing(user, deps, (await replyOf(deps, conv.id)).id);

    await (await send({ text: "Note it" })).text();

    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "awaiting_approval",
      parts: storedParts([
        {
          type: "tool_call",
          toolCallId: "note-1",
          name: "post_note",
          source: "host",
          args: { note: "Hi" },
          state: "awaiting_approval",
        },
      ]),
    });
  });

  it("deleting the Conversation removes its allowance with it", async () => {
    const { user, deps, conv, send } = await setup({
      rounds: [round(mailCall("call-1")), round(text("Sent."))],
    });
    await (await send()).text();
    await decideAllowing(user, deps, (await replyOf(deps, conv.id)).id);

    await chatRpc({ user, deps }).conversation.delete({ id: conv.id });

    expect(await deps.db.select().from(conversation).where(eq(conversation.id, conv.id))).toEqual(
      [],
    );
  });

  it("deleting the user removes the allowances of their Conversations", async () => {
    const { user, deps, conv, send } = await setup({
      rounds: [round(mailCall("call-1")), round(text("Sent."))],
    });
    await (await send()).text();
    await decideAllowing(user, deps, (await replyOf(deps, conv.id)).id);

    await deleteUserData(deps, user.id);

    expect(
      await deps.db.select().from(conversation).where(eq(conversation.userId, user.id)),
    ).toEqual([]);
  });
});

/** The Host's OpenAI: an embedding Model for Knowledge and an Image Model, so no user key is needed. */
const hostOpenAI: HostProvider = {
  provider: "openai",
  credentials: { apiKey: "sk-host-openai" },
  models: [],
  embeddingModels: [{ model: "text-embedding-3-small", pricePerMillionTokensUsd: 0.02 }],
  imageModels: [
    { modelId: "gpt-image-1-mini", size: "1024x1024", quality: "medium", pricePerImageUsd: 0.01 },
  ],
};

const toolNamesOf = (fake: FakeAdapter, call: number) =>
  (fake.calls[call]?.tools ?? []).map((tool) => tool.name);

/**
 * A Run in a Project with a ready Knowledge file, web search on, an Image Model and Memory: it
 * searches the web, draws an image and searches Knowledge, then asks to send mail. The approved
 * call's Run makes the fifth model call.
 */
async function askAfterEveryFeature() {
  const runs: Runs = [];
  const user = await insertUser();
  const fake = createFakeAdapter({
    rounds: [
      round(toolCall({ id: "search-1", name: "web_search", input: { query: "news" } })),
      round(toolCall({ id: "image-1", name: "generate_image", input: { prompt: "a bicycle" } })),
      round(toolCall({ id: "knowledge-1", name: "search_knowledge", input: { query: "budget" } })),
      round(mailCall("call-1")),
      round(text("Sent.")),
    ],
  });
  const deps = createTestSdk({
    adapterFor: () => fake.adapter,
    tools: [sendMail(runs)],
    hostProviders: [hostOpenAI],
    defaultImageModel: "openai:gpt-image-1-mini",
    imageAdapterFor: () => fakeImageAdapter(),
    searchClient: createFakeSearchClient({
      results: [{ title: "News", url: "https://example.com/news", snippet: "News." }],
    }),
  });
  for (const service of ["anthropic", "tavily"]) {
    await saveCredentials(deps, user.id, {
      service,
      fields: { apiKey: `${service}-test-key` },
      hint: "…-key",
      verified: true,
    });
  }
  const rpc = chatRpc({ user, deps });
  const { id: projectId } = await rpc.project.create({ name: "Thesis" });
  await rpc.knowledge.upload({
    projectId,
    file: new File(["The 2026 budget is set."], "notes.md", { type: "text/markdown" }),
  });
  await drainJobs({ deps });
  const conv = await insertConversation(user, { title: "Everything", projectId });
  const response = await sendAs(
    new Request(`${basePath}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        forwardedProps: {
          conversationId: conv.id,
          parentId: null,
          text: "Search, draw, read, then email a@b.c",
          attachmentIds: [],
          model: anthropicModel,
          webSearch: true,
        },
      }),
    }),
    user,
    deps,
  );
  await response.text();
  const reply = await replyOf(deps, conv.id);
  expect(reply.status).toBe("awaiting_approval");
  await rpc.chat.decide({ messageId: reply.id, approved: true });
  await join(reply.id, user, deps);
  expect(runs).toHaveLength(1);
  return { deps, fake, conv };
}

describe("a Run resumed after an Approval is planned like the Run that asked (ADR 0008)", () => {
  it("offers web search, fetch_url, image, Knowledge and past-chats tools", async () => {
    const { fake } = await askAfterEveryFeature();

    const resumed = toolNamesOf(fake, 4);
    expect(resumed).toEqual(
      expect.arrayContaining([
        "web_search",
        "fetch_url",
        "generate_image",
        "search_knowledge",
        "search_past_chats",
        "send_mail",
      ]),
    );
    expect(resumed.toSorted()).toEqual(toolNamesOf(fake, 3).toSorted());
  });

  it("sends the citation and Knowledge-files prompts", async () => {
    const { fake } = await askAfterEveryFeature();

    const prompts = fake.calls[4]!.systemPrompts ?? [];
    expect(prompts).toContain(citationPrompt);
    expect(prompts).toContain(knowledgePromptOf(["notes.md"]));
    expect(prompts).toEqual(fake.calls[3]!.systemPrompts);
  });

  it("replays the earlier web search, image and Knowledge calls as calls, not placeholders", async () => {
    const { fake } = await askAfterEveryFeature();

    const replayed = fake.calls[4]!.messages.flatMap((sent) =>
      (sent.toolCalls ?? []).map((call) => call.function.name),
    );
    expect(replayed).toEqual(
      expect.arrayContaining(["web_search", "generate_image", "search_knowledge", "send_mail"]),
    );
  });

  it("compacts a long history, and records the first Message the resumed Run sent", async () => {
    const novaPro = "bedrock:us.amazon.nova-pro-v1:0";
    const user = await insertUser();
    const fake = createFakeAdapter({ rounds: [round(mailCall("call-1")), round(text("Sent."))] });
    const deps = createTestSdk({ adapterFor: () => fake.adapter, tools: [sendMail([])] });
    await saveCredentials(deps, user.id, {
      service: "bedrock",
      fields: { apiKey: "test-key" },
      hint: "…-key",
      verified: true,
    });
    const conv = await insertConversation(user, { model: novaPro, title: "Long" });
    // Four Messages of ~100,000 tokens against a ~288,000-token budget: the oldest two don't fit.
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const row = await insertMessage({
        conversationId: conv.id,
        parentId: ids.at(-1) ?? null,
        role: index % 2 === 0 ? "user" : "assistant",
        text: `m${index} ${"x".repeat(400_000)}`,
        active: index === 3,
      });
      ids.push(row.id);
    }
    const response = await sendAs(
      new Request(`${basePath}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: ids.at(-1),
            text: "Email a@b.c",
            attachmentIds: [],
            model: novaPro,
            webSearch: false,
          },
        }),
      }),
      user,
      deps,
    );
    await response.text();
    const reply = await replyOf(deps, conv.id);
    expect(reply.status).toBe("awaiting_approval");

    await chatRpc({ user, deps }).chat.decide({ messageId: reply.id, approved: true });
    await join(reply.id, user, deps);

    const sent = JSON.stringify(fake.calls[1]!.messages);
    expect(sent).not.toContain("m0 ");
    expect(sent).not.toContain("m1 ");
    expect(sent).toContain("m2 ");
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      contextStartId: ids[2],
    });
  });
});

describe("the decision carries the user's web search choice to the resumed Run", () => {
  /**
   * A Run sent with web search on that plays `rounds` and asks for Approval, with Tavily
   * credentials so the Web tools can be offered.
   */
  async function ask(rounds = [round(mailCall("call-1")), round(text("Sent."))]) {
    const ready = await setup({
      rounds,
      deps: {
        searchClient: createFakeSearchClient({
          results: [{ title: "News", url: "https://example.com/news", snippet: "News." }],
        }),
      },
    });
    await saveCredentials(ready.deps, ready.user.id, {
      service: "tavily",
      fields: { apiKey: "tavily-test-key" },
      hint: "…-key",
      verified: true,
    });
    await (await ready.send({ webSearch: true })).text();
    const reply = await replyOf(ready.deps, ready.conv.id);
    expect(reply.status).toBe("awaiting_approval");
    return { ...ready, reply };
  }

  it("offers the Web tools when the user decides with web search on, though the reply never searched", async () => {
    const { user, deps, fake, reply } = await ask();
    expect(toolNamesOf(fake, 0)).toContain("web_search");

    await chatRpc({ user, deps }).chat.decide({
      messageId: reply.id,
      approved: true,
      webSearch: true,
    });
    await join(reply.id, user, deps);

    expect(toolNamesOf(fake, 1)).toEqual(expect.arrayContaining(["web_search", "fetch_url"]));
  });

  it("leaves the Web tools out when the user decides with web search off, though the reply searched", async () => {
    const { user, deps, fake, reply } = await ask([
      round(toolCall({ id: "search-1", name: "web_search", input: { query: "news" } })),
      round(mailCall("call-1")),
      round(text("Sent.")),
    ]);

    await chatRpc({ user, deps }).chat.decide({
      messageId: reply.id,
      approved: true,
      webSearch: false,
    });
    await join(reply.id, user, deps);

    expect(toolNamesOf(fake, 2)).not.toContain("web_search");
  });
});
