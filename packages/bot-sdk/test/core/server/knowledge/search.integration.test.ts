import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { fakeEmbeddingAdapter } from "../../../../plugins/models/server/fake-embedding-adapter";
import { conversation, message } from "../../../../core/server/db/schema";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import type { HostProvider } from "../../../../core/server/deps";
import type { ChatCommand } from "../../../../core/shared/chat/command";
import { insertConversation } from "../../../support/conversations";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { drainJobs } from "../../../support/jobs";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";

/** The Host offers OpenAI's small embedding Model, so no user key is needed to embed. */
const hostOpenAI: HostProvider = {
  provider: "openai",
  credentials: { apiKey: "sk-host-openai" },
  models: [],
  embeddingModels: [{ model: "text-embedding-3-small", pricePerMillionTokensUsd: 0.02 }],
};

/**
 * A signed-in user with Anthropic credentials, a Project and a Conversation in it. Embeddings fail
 * while `setEmbeddingsFail(true)` is set, so a test can break the query's embedding alone.
 */
async function setup(rounds: Parameters<typeof createFakeAdapter>[0]["rounds"]) {
  const user = await insertUser();
  const fake = createFakeAdapter({ rounds });
  let failing = false;
  const working = fakeEmbeddingAdapter();
  const broken = fakeEmbeddingAdapter({ fail: "embedding service down" });
  const deps = createTestSdk({
    adapterFor: () => fake.adapter,
    hostProviders: [hostOpenAI],
    embeddingAdapterFor: () => (failing ? broken : working),
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "...-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id: projectId } = await rpc.project.create({ name: "Thesis" });
  const conv = await insertConversation(user, { title: "Thesis", projectId });
  const send = (command: Partial<ChatCommand> = {}) =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "What is the 2026 budget?",
            attachmentIds: [],
            model: anthropicModel,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
  return {
    deps,
    rpc,
    fake,
    projectId,
    conv,
    send,
    setEmbeddingsFail: (fail: boolean) => {
      failing = fail;
    },
  };
}

/** Uploads a Markdown Knowledge file to a Project and drains its processing, so it is Ready. */
async function uploadReady(
  rpc: ReturnType<typeof chatRpc>,
  deps: TestDeps,
  projectId: string,
  name: string,
  body: string,
) {
  await rpc.knowledge.upload({
    projectId,
    file: new File([body], name, { type: "text/markdown" }),
  });
  await drainJobs({ deps });
}

/** The newest assistant Message of a Conversation: the reply the last send wrote. */
async function latestReply(deps: TestDeps, conversationId: string) {
  const rows = await deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(desc(message.createdAt));
  const reply = rows.find((candidate) => candidate.role === "assistant");
  if (!reply) throw new Error("The Conversation has no reply");
  return reply;
}

const offeredTools = (fake: ReturnType<typeof createFakeAdapter>, call = 0) =>
  (fake.calls[call]?.tools ?? []).map((tool) => tool.name);

const promptsOf = (fake: ReturnType<typeof createFakeAdapter>, call = 0) =>
  (fake.calls[call]?.systemPrompts ?? []).join("\n");

const searchCall = (query: string) =>
  toolCall({ id: "call-1", name: "search_knowledge", input: { query } });

describe("the search_knowledge tool", () => {
  it("is offered with the Project's ready file names, and not while its only file is processing", async () => {
    const { deps, rpc, projectId, conv, fake, send } = await setup([
      round(text("Reading.")),
      round(text("Now ready.")),
    ]);
    await rpc.knowledge.upload({
      projectId,
      file: new File(["Still reading."], "draft.md", { type: "text/markdown" }),
    });

    await (await send()).text();
    expect(offeredTools(fake)).not.toContain("search_knowledge");
    expect(promptsOf(fake)).not.toContain("draft.md");

    await drainJobs({ deps });
    const first = await latestReply(deps, conv.id);
    await (await send({ text: "And now?", parentId: first.id })).text();
    expect(offeredTools(fake, 1)).toContain("search_knowledge");
    expect(promptsOf(fake, 1)).toContain("draft.md");
  });

  it("is not offered once the Conversation has left its Project", async () => {
    const { deps, rpc, projectId, conv, fake, send } = await setup([
      round(text("First.")),
      round(text("Second.")),
    ]);
    await uploadReady(rpc, deps, projectId, "notes.md", "Our notes say the budget is set.");

    await (await send()).text();
    expect(offeredTools(fake)).toContain("search_knowledge");
    const first = await latestReply(deps, conv.id);

    await getTestDb()
      .update(conversation)
      .set({ projectId: null })
      .where(eq(conversation.id, conv.id));
    await (await send({ text: "Still?", parentId: first.id })).text();
    expect(offeredTools(fake, 1)).not.toContain("search_knowledge");
    expect(promptsOf(fake, 1)).not.toContain("notes.md");
  });

  it("searches the Project's ready files, stores the passages it found, and never reads another Project", async () => {
    const { deps, rpc, projectId, conv, fake, send } = await setup([
      round(text("Checking."), searchCall("2026 budget")),
      round(text("It is 4 million dollars.")),
    ]);
    await uploadReady(
      rpc,
      deps,
      projectId,
      "budget.md",
      "The budget for 2026 is 4 million dollars.",
    );
    const { id: otherProjectId } = await rpc.project.create({ name: "Other" });
    await uploadReady(
      rpc,
      deps,
      otherProjectId,
      "other.md",
      "The budget for 2026 is 9 million dollars.",
    );

    await (await send()).text();

    const reply = await latestReply(deps, conv.id);
    expect(reply.status).toBe("complete");
    const stored = reply.parts as { schemaVersion: number; parts: Array<Record<string, unknown>> };
    expect(stored.schemaVersion).toBe(5);
    const part = stored.parts.find((candidate) => candidate.type === "knowledge_search")!;
    expect(part).toMatchObject({
      type: "knowledge_search",
      toolCallId: "call-1",
      query: "2026 budget",
      state: "done",
    });
    const excerpts = part.excerpts as Array<{ fileName: string; text: string; chunkIndex: number }>;
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toMatchObject({ fileName: "budget.md", chunkIndex: 0 });
    expect(excerpts[0]!.text).toContain("4 million");
    expect(JSON.stringify(stored)).not.toContain("9 million");

    // The Model read the passage under its id, and the prompt named only this Project's file.
    const result = fake.calls[1]!.messages.at(-1)!;
    expect(result).toMatchObject({ role: "tool", toolCallId: "call-1" });
    expect(JSON.parse(String(result.content))).toEqual({
      excerpts: [{ id: "excerpt:1", fileName: "budget.md", text: excerpts[0]!.text }],
    });
    expect(promptsOf(fake)).toContain("budget.md");
    expect(promptsOf(fake)).not.toContain("other.md");
  });

  it("labels each search's passages after the reply's earlier ones, so no two Excerpts share a label", async () => {
    const { deps, rpc, projectId, send, fake } = await setup([
      round(
        text("Checking."),
        toolCall({ id: "call-1", name: "search_knowledge", input: { query: "2026 budget" } }),
      ),
      round(
        text("Checking the deadline."),
        toolCall({ id: "call-2", name: "search_knowledge", input: { query: "deadline" } }),
      ),
      round(text("Done.")),
    ]);
    await uploadReady(
      rpc,
      deps,
      projectId,
      "budget.md",
      "The budget for 2026 is 4 million dollars.",
    );
    await uploadReady(rpc, deps, projectId, "plan.md", "The deadline for the plan is in May.");

    await (await send()).text();

    const results = fake.calls[2]!.messages.filter((message) => message.role === "tool").map(
      (message) => (JSON.parse(String(message.content)) as { excerpts: { id: string }[] }).excerpts,
    );
    const [first, second] = results;
    expect(first!.length).toBeGreaterThan(0);
    expect(second![0]!.id).toBe(`excerpt:${first!.length + 1}`);
  });

  it("tells the Model Knowledge is unavailable when the search fails, and the reply goes on", async () => {
    const { deps, rpc, projectId, conv, fake, send, setEmbeddingsFail } = await setup([
      round(text("Checking."), searchCall("2026 budget")),
      round(text("I could not check the files.")),
    ]);
    await uploadReady(
      rpc,
      deps,
      projectId,
      "budget.md",
      "The budget for 2026 is 4 million dollars.",
    );
    setEmbeddingsFail(true);

    await (await send()).text();

    const reply = await latestReply(deps, conv.id);
    expect(reply.status).toBe("complete");
    const stored = reply.parts as { parts: Array<Record<string, unknown>> };
    expect(stored.parts.find((candidate) => candidate.type === "knowledge_search")).toMatchObject({
      state: "error",
      error: { code: "chat.knowledgeFailed" },
    });
    expect(JSON.parse(String(fake.calls[1]!.messages.at(-1)!.content))).toEqual({
      error: "Knowledge unavailable",
    });
  });
});
