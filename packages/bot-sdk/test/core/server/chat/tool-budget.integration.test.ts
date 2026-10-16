import type { StoredPart } from "../../../../core/shared/message-parts";
import { message } from "../../../../core/server/db/schema";
import { toolDefinition } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { HostToolContext } from "../../../../core/server/chat/host-tools";
import { fakeImageAdapter } from "../../../../core/server/chat/fake-image-adapter";
import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps, HostProvider } from "../../../../core/server/deps";
import { insertConversation } from "../../../support/conversations";
import { createTestSdk } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { createFakeSearchClient } from "../../../support/fake-search-client";
import { drainJobs } from "../../../support/jobs";
import { chatRpc, sendAs } from "../../../support/sdk";
import { insertUser } from "../../../support/users";

const basePath = "http://localhost/api/chat";

/** The Host's OpenAI: an embedding Model for Knowledge and an Image Model. */
const hostOpenAI: HostProvider = {
  provider: "openai",
  credentials: { apiKey: "sk-host-openai" },
  models: [],
  embeddingModels: [{ model: "text-embedding-3-small", pricePerMillionTokensUsd: 0.02 }],
  imageModels: [
    { modelId: "gpt-image-1-mini", size: "1024x1024", quality: "medium", pricePerImageUsd: 0.01 },
  ],
};

const page = "https://example.com/page";

/** A fetch that answers every URL with one plain-text page. */
const pageFetch = (async () =>
  new Response("Hello", { headers: { "content-type": "text/plain" } })) as typeof fetch;

/** `send_mail`, which waits for Approval when `approval` is set. */
const sendMail = (approval: boolean) =>
  toolDefinition({
    name: "send_mail",
    description: "Sends an email.",
    inputSchema: z.object({ to: z.string() }),
    needsApproval: approval,
  }).server<HostToolContext>(async () => ({ sent: true }));

const serverTime = toolDefinition({
  name: "server_time",
  description: "The current server time.",
  inputSchema: z.object({}),
}).server<HostToolContext>(async () => ({ now: "noon" }));

const times = <T>(count: number, make: (index: number) => T) =>
  Array.from({ length: count }, (_, index) => make(index + 1));

/**
 * One reply: `first` (the calls under test), then a `send_mail` call, then 11 `server_time`
 * calls. With `approval`, the reply waits at `send_mail` and a second Run continues it once it is
 * approved; without, it is one Run. Answers how many of the 11 `server_time` calls ran: what the
 * budget had left for them.
 */
async function timeCallsLeft(
  first: ReturnType<typeof toolCall>[],
  { approval, knowledge }: { approval: boolean; knowledge: boolean },
) {
  const user = await insertUser();
  const fake = createFakeAdapter({
    rounds: [
      round(...first),
      round(toolCall({ id: "mail-1", name: "send_mail", input: { to: "a@b.c" } })),
      round(
        ...times(11, (index) => toolCall({ id: `after-${index}`, name: "server_time", input: {} })),
      ),
      round(text("Done.")),
    ],
  });
  const deps = createTestSdk({
    adapterFor: () => fake.adapter,
    tools: [sendMail(approval), serverTime],
    hostProviders: [hostOpenAI],
    defaultImageModel: "openai:gpt-image-1-mini",
    imageAdapterFor: () => fakeImageAdapter(),
    searchClient: createFakeSearchClient({
      results: [{ title: "News", url: page, snippet: "News." }],
    }),
    fetch: pageFetch,
    artifacts: true,
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
  let projectId: string | null = null;
  if (knowledge) {
    ({ id: projectId } = await rpc.project.create({ name: "Thesis" }));
    await rpc.knowledge.upload({
      projectId,
      file: new File(["The 2026 budget is set."], "notes.md", { type: "text/markdown" }),
    });
    await drainJobs({ deps });
  }
  const conv = await insertConversation(user, { title: "Budget", projectId });
  const response = await sendAs(
    new Request(`${basePath}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        forwardedProps: {
          conversationId: conv.id,
          parentId: null,
          text: "Go",
          attachmentIds: [],
          model: "anthropic:claude-sonnet-5-5",
          webSearch: true,
        },
      }),
    }),
    user,
    deps,
  );
  await response.text();
  if (approval) {
    const waiting = await replyOf(deps, conv.id);
    expect(waiting.status).toBe("awaiting_approval");
    await rpc.chat.decide({ messageId: waiting.id, approved: true });
    await (
      await sendAs(
        new Request(`${basePath}/run?runId=${waiting.id}`, { method: "GET" }),
        user,
        deps,
      )
    ).text();
  }
  const reply = await replyOf(deps, conv.id);
  expect(reply.status).toBe("complete");
  return (reply.parts as { parts: StoredPart[] }).parts.filter(
    (part) =>
      part.type === "tool_call" && part.toolCallId.startsWith("after-") && part.state === "done",
  ).length;
}

async function replyOf(deps: AppDeps, conversationId: string) {
  const rows = await deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.filter((row) => row.role === "assistant").at(-1)!;
}

const cases: Array<{
  name: string;
  first: ReturnType<typeof toolCall>[];
  /** How many of `first` count against the reply's 10 calls. */
  counted: number;
  knowledge?: boolean;
}> = [
  {
    name: "Host tool calls",
    first: times(2, (index) => toolCall({ id: `first-${index}`, name: "server_time", input: {} })),
    counted: 2,
  },
  {
    name: "Artifact calls",
    first: times(2, (index) =>
      toolCall({
        id: `first-${index}`,
        name: "create_artifact",
        input: { kind: "markdown", title: `Note ${index}`, content: "# Note" },
      }),
    ),
    counted: 2,
  },
  {
    name: "Generated images",
    first: times(2, (index) =>
      toolCall({ id: `first-${index}`, name: "generate_image", input: { prompt: "a bicycle" } }),
    ),
    counted: 2,
  },
  {
    name: "Generated images past the Run's 4, where the fifth, refused, takes no call",
    first: times(5, (index) =>
      toolCall({ id: `first-${index}`, name: "generate_image", input: { prompt: "a bicycle" } }),
    ),
    counted: 4,
  },
  {
    name: "Knowledge searches",
    first: times(2, (index) =>
      toolCall({ id: `first-${index}`, name: "search_knowledge", input: { query: "budget" } }),
    ),
    counted: 2,
    knowledge: true,
  },
  {
    name: "fetch_url calls, which have their own cap",
    first: times(2, (index) =>
      toolCall({ id: `first-${index}`, name: "fetch_url", input: { url: page } }),
    ),
    counted: 0,
  },
  {
    name: "web searches, which have their own cap",
    first: times(2, (index) =>
      toolCall({ id: `first-${index}`, name: "web_search", input: { query: "news" } }),
    ),
    counted: 0,
  },
];

describe("the reply's tool budget is the same in one Run and across an Approval (ADR 0008)", () => {
  for (const { name, first, counted, knowledge = false } of cases) {
    it(`counts ${name} the same way`, async () => {
      // The 10 calls less those of `first` that count, less the `send_mail` call.
      const left = 10 - counted - 1;

      expect(await timeCallsLeft(first, { approval: false, knowledge })).toBe(left);
      expect(await timeCallsLeft(first, { approval: true, knowledge })).toBe(left);
    });
  }
});
