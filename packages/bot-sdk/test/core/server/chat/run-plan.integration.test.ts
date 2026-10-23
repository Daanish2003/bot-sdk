import { toolDefinition } from "@tanstack/ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fakeImageAdapter } from "../../../../plugins/models/server/fake-image-adapter";
import { createToolBudget } from "../../../../plugins/assistant/server/chat/tracked-tool";
import { planRun, type RunPlan } from "../../../../plugins/assistant/server/chat/run-plan";
import { findConversation } from "../../../../plugins/assistant/server/chat/store";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import type { HostProvider } from "../../../../plugins/assistant/server/deps";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { createPartsBuilder } from "../../../../plugins/assistant/shared/chat/parts";
import { storedParts, type StoredPart } from "../../../../plugins/assistant/shared/message-parts";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestSdk, chatRpc } from "../../../support/assistant";
import { createFakeAdapter } from "../../../support/fake-adapter";
import { insertUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";

const hostOpenAI: HostProvider = {
  provider: "openai",
  credentials: { apiKey: "sk-host-openai" },
  models: [],
  imageModels: [
    { modelId: "gpt-image-1-mini", size: "1024x1024", quality: "medium", pricePerImageUsd: 0.01 },
  ],
};

const sendMail = toolDefinition({
  name: "send_mail",
  description: "Sends an email.",
  inputSchema: z.object({ to: z.string() }),
  needsApproval: true,
}).server(async () => ({ sent: true }));

/** What a plan decides, without its adapter and closures: the tools by name. */
function summaryOf(plan: RunPlan) {
  const tools = plan.tools({
    parts: createPartsBuilder(),
    onChange: () => {},
    budget: createToolBudget(0),
  });
  return {
    model: plan.model.id,
    effort: plan.effort,
    tools: tools.map((tool) => tool.name).toSorted(),
    systemPrompts: plan.systemPrompts,
    modelOptions: plan.modelOptions,
    compacted: plan.compaction !== undefined,
    onHost: plan.meter.onHost,
  };
}

/**
 * A Conversation in a Project, on a user with Anthropic and Tavily keys
 * and a Host Image Model: a user Message, and a reply that searched the web and waits on a call.
 */
async function waitingConversation() {
  const user = await insertUser();
  const deps = createTestSdk({
    adapterFor: () => createFakeAdapter({ rounds: [] }).adapter,
    tools: [sendMail],
    hostProviders: [hostOpenAI],
    defaultImageModel: "openai:gpt-image-1-mini",
    imageAdapterFor: () => fakeImageAdapter(),
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
  const conv = await insertConversation(user, { title: "Waiting", projectId });
  const asked = await insertMessage({
    conversationId: conv.id,
    role: "user",
    text: "Search, then email a@b.c",
  });
  const waiting = await insertMessage({
    conversationId: conv.id,
    parentId: asked.id,
    role: "assistant",
    text: "",
    active: true,
    model: anthropicModel,
    status: "awaiting_approval",
    parts: storedParts([
      {
        type: "web_search",
        toolCallId: "search-1",
        query: "news",
        state: "done",
        results: [{ title: "News", url: "https://example.com/news", snippet: "News." }],
      },
      {
        type: "tool_call",
        toolCallId: "call-1",
        name: "send_mail",
        source: "host",
        args: { to: "a@b.c" },
        state: "awaiting_approval",
      } as StoredPart,
    ]),
  });
  const owned = (await findConversation(deps, user.id, conv.id))!;
  const base = {
    userId: user.id,
    conversation: owned,
    model: anthropicModel,
    reasoningEffort: null,
    web: true,
  };
  return { deps, asked, waiting, base };
}

describe("planRun", () => {
  it("plans a resume as it plans a send for the same Conversation and Model", async () => {
    const { deps, asked, waiting, base } = await waitingConversation();

    const send = await planRun(
      deps,
      {
        ...base,
        replyId: uuidv7(),
        leafId: asked.id,
        // A regenerate answers the same user Message the waiting reply answers.
        send: { text: undefined, userMessageId: uuidv7(), attachmentIds: [] },
      },
      async (plan) => ({ summary: summaryOf(plan), messages: plan.messages }),
    );
    const resume = await planRun(
      deps,
      { ...base, replyId: waiting.id, leafId: waiting.id },
      async (plan) => ({ summary: summaryOf(plan), messages: plan.messages }),
    );

    if (!("done" in send) || !("done" in resume)) throw new Error("A plan was refused");
    expect(send.done.summary.tools).toEqual([
      "fetch_url",
      "generate_image",
      "search_past_chats",
      "send_mail",
      "web_search",
    ]);
    expect(resume.done.summary).toEqual(send.done.summary);
    // The resume reads the same path, then the waiting reply, whose calls replay as calls.
    expect(resume.done.messages.slice(0, send.done.messages.length)).toEqual(send.done.messages);
    expect(
      resume.done.messages.flatMap((sent) =>
        (sent.toolCalls ?? []).map((call) => call.function.name),
      ),
    ).toEqual(["web_search", "send_mail"]);
  });

  it("refuses a send that would continue a waiting reply, and a resume of it is planned", async () => {
    const { deps, waiting, base } = await waitingConversation();
    let used = 0;

    const send = await planRun(
      deps,
      {
        ...base,
        replyId: uuidv7(),
        leafId: waiting.id,
        send: { text: "Keep going", userMessageId: uuidv7(), attachmentIds: [] },
      },
      async () => used++,
    );
    const resume = await planRun(
      deps,
      { ...base, replyId: waiting.id, leafId: waiting.id },
      async () => used++,
    );

    expect(send).toEqual({ refused: { status: 409, code: "error.approveFirst", params: {} } });
    expect(resume).toEqual({ done: 0 });
    expect(used).toBe(1);
  });
});
