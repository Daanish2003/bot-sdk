import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { conversation, message } from "../../../../core/server/db/schema/chat";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { loadActiveBranch } from "../../../../core/server/chat/store";
import { getTestDb } from "../../../support/test-database";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { insertUser } from "../../../support/users";
import { sendAs } from "../../../support/sdk";

/**
 * Nova Pro: a 300,000-token window and a 10,000-token max output, so its budget is 288,000 tokens
 * (less the margin). A ~400,000-character Message is about 100,000 tokens.
 */
const novaPro = "bedrock:us.amazon.nova-pro-v1:0";
/** A curated Model whose window is unknown (models.dev has no entry for it). */
const unknownWindow = "groq:qwen/qwen3-32b";

const bigText = (id: string, characters: number) => `${id} ${"x".repeat(characters)}`;

/** A Conversation of `count` alternating Messages, each `characters` long, the last one active. */
async function seedHistory(
  conversationId: string,
  count: number,
  characters: number,
): Promise<string[]> {
  const ids: string[] = [];
  let parentId: string | null = null;
  for (let index = 0; index < count; index++) {
    const id = `m${index}`;
    const row = await insertMessage({
      conversationId,
      parentId,
      role: index % 2 === 0 ? "user" : "assistant",
      text: bigText(id, characters),
      active: index === count - 1,
    });
    ids.push(row.id);
    parentId = row.id;
  }
  return ids;
}

/** Sends a Message on `model` from the end of a seeded history, and waits for the Run to end. */
async function runOn({
  model,
  service,
  count,
  characters,
  newText = "What now?",
}: {
  model: string;
  service: string;
  count: number;
  characters: number;
  newText?: string;
}) {
  const user = await insertUser();
  const fake = createFakeAdapter({ rounds: [round(text("Ok."))] });
  const deps = createTestDeps({ adapterFor: () => fake.adapter });
  await saveCredentials(deps, user.id, {
    service,
    fields: { apiKey: "test-key" },
    hint: "…-key",
    verified: true,
  });
  // Titled, so no title call takes the scripted adapter.
  const conv = await insertConversation(user, { model, title: "Test Conversation" });
  const ids = await seedHistory(conv.id, count, characters);
  const response = await sendAs(
    new Request("http://localhost/api/chat/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        forwardedProps: {
          conversationId: conv.id,
          parentId: ids.at(-1) ?? null,
          text: newText,
          attachmentIds: [],
          model,
          webSearch: false,
        },
      }),
    }),
    user,
    deps,
  );
  const body = await response.text();
  return { status: response.status, body, fake, conv, ids, deps };
}

/** The reply stored under the Conversation, once the Run has ended. */
async function replyOf(conversationId: string) {
  const [row] = await getTestDb()
    .select({ reply: message })
    .from(conversation)
    .innerJoin(message, eq(message.id, conversation.activeLeafId))
    .where(eq(conversation.id, conversationId));
  return row?.reply;
}

describe("compaction on a Run", () => {
  it("sends only the newest Messages over the budget, and records the first one sent", async () => {
    // Four history Messages of ~100,000 tokens and a short new one: the oldest does not fit.
    const run = await runOn({ model: novaPro, service: "bedrock", count: 4, characters: 400_000 });
    expect(run.status).toBe(200);

    const sent = run.fake.calls[0]!.messages.map((messageSent) =>
      typeof messageSent.content === "string"
        ? messageSent.content
        : JSON.stringify(messageSent.content),
    );
    expect(sent.some((content) => content.includes("m0 "))).toBe(false);
    expect(sent.some((content) => content.includes("m1 "))).toBe(false);
    expect(sent.some((content) => content.includes("m2 "))).toBe(true);
    expect(sent.some((content) => content.includes("m3 "))).toBe(true);

    const reply = await replyOf(run.conv.id);
    expect(reply?.contextStartId).toBe(run.ids[2]);
  });

  it("keeps the Message tree whole: every Message stored and on the Active Branch", async () => {
    const run = await runOn({ model: novaPro, service: "bedrock", count: 4, characters: 400_000 });

    const stored = await getTestDb()
      .select({ id: message.id })
      .from(message)
      .where(eq(message.conversationId, run.conv.id));
    expect(stored).toHaveLength(4 + 1 + 1);

    const reply = await replyOf(run.conv.id);
    const branch = await loadActiveBranch(run.deps, run.conv.id, reply!.id);
    // The four history Messages, the new one, and the reply: none dropped from the tree.
    expect(branch.map((row) => row.id).slice(0, 4)).toEqual(run.ids);
    expect(branch).toHaveLength(6);
    expect(branch.at(-1)?.id).toBe(reply!.id);
  });

  it("returns each Message's context start on the Conversation read", async () => {
    const run = await runOn({ model: novaPro, service: "bedrock", count: 4, characters: 400_000 });

    const reply = await replyOf(run.conv.id);
    const branch = await loadActiveBranch(run.deps, run.conv.id, reply!.id);
    expect(branch.at(-1)?.contextStartId).toBe(run.ids[2]);
    expect(branch[0]?.contextStartId).toBeNull();
  });

  it("refuses a new Message too big for the budget on its own, before anything is written", async () => {
    // About 300,000 tokens: more than the whole budget, so it is refused.
    const run = await runOn({
      model: novaPro,
      service: "bedrock",
      count: 0,
      characters: 0,
      newText: "x".repeat(1_200_000),
    });

    expect(run.status).toBe(400);
    expect(run.body).toContain("too long for the Model's context window");
    const stored = await getTestDb()
      .select({ id: message.id })
      .from(message)
      .where(eq(message.conversationId, run.conv.id));
    expect(stored).toHaveLength(0);
    expect(run.fake.calls).toHaveLength(0);
  });

  it("sends every Message and records null for a Model whose window is unknown", async () => {
    const run = await runOn({
      model: unknownWindow,
      service: "groq",
      count: 4,
      characters: 400_000,
    });

    expect(run.fake.calls[0]!.messages).toHaveLength(4 + 1);
    const reply = await replyOf(run.conv.id);
    expect(reply?.contextStartId).toBeNull();
  });

  it("records null for a Conversation that fits", async () => {
    const run = await runOn({ model: novaPro, service: "bedrock", count: 2, characters: 1_000 });

    expect(run.fake.calls[0]!.messages).toHaveLength(2 + 1);
    const reply = await replyOf(run.conv.id);
    expect(reply?.contextStartId).toBeNull();
  });
});
