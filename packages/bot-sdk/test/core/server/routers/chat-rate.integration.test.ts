import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import { loadSharedConversation } from "../../../../core/server/share/store";
import { message } from "../../../../core/server/db/schema/chat";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { chatRpc, sendAs } from "../../../support/sdk";
import { insertUser, type TestUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";

/** An owner with a Conversation holding a question and an ended reply on the Active Branch. */
async function setup(
  replyStatus: "complete" | "stopped" | "error" | "streaming" | "awaiting_approval" = "complete",
) {
  const user: TestUser = await insertUser();
  const deps = createTestDeps();
  const conv = await insertConversation(user, { title: "Ratings" });
  const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
  const reply = await insertMessage({
    conversationId: conv.id,
    parentId: question.id,
    role: "assistant",
    text: "Hello!",
    status: replyStatus,
    active: true,
  });
  const rate = (messageId: string, rating: "up" | "down" | null, as: TestUser = user) =>
    chatRpc({ user: as, deps }).chat.rate({ messageId, rating });
  const row = async (id: string) =>
    (await deps.db.select().from(message).where(eq(message.id, id)))[0]!;
  return { user, deps, conv, question, reply, rate, row };
}

describe("chat.rate", () => {
  it("sets an up or down Rating on an ended reply and stamps when", async () => {
    const { reply, rate, row } = await setup();

    await rate(reply.id, "up");

    expect(await row(reply.id)).toMatchObject({
      rating: "up",
      ratedAt: expect.any(Date),
    });
  });

  it("flips the Rating to the other thumb, keeping only the latest", async () => {
    const { reply, rate, row } = await setup();
    await rate(reply.id, "up");

    await rate(reply.id, "down");

    expect(await row(reply.id)).toMatchObject({ rating: "down", ratedAt: expect.any(Date) });
  });

  it("clears the Rating with null", async () => {
    const { reply, rate, row } = await setup();
    await rate(reply.id, "down");

    await rate(reply.id, null);

    expect(await row(reply.id)).toMatchObject({ rating: null, ratedAt: null });
  });

  it("can rate a reply that was stopped or failed", async () => {
    for (const status of ["stopped", "error"] as const) {
      const { reply, rate, row } = await setup(status);
      await rate(reply.id, "up");
      expect((await row(reply.id)).rating).toBe("up");
    }
  });

  it("answers 404 to anyone but the Conversation's owner, and leaves the Rating alone", async () => {
    const { reply, rate, row } = await setup();
    const stranger = await insertUser();
    await rate(reply.id, "up");

    await expect(rate(reply.id, "down", stranger)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await row(reply.id)).rating).toBe("up");
  });

  it("answers 409 while the reply's Run is still streaming", async () => {
    const { reply, rate, row } = await setup("streaming");

    await expect(rate(reply.id, "up")).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await row(reply.id)).rating).toBeNull();
  });

  it("answers 409 for a reply waiting for an Approval", async () => {
    const { reply, rate, row } = await setup("awaiting_approval");

    await expect(rate(reply.id, "up")).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await row(reply.id)).rating).toBeNull();
  });

  it("answers 400 for a user Message, which is never rated", async () => {
    const { question, rate, row } = await setup();

    await expect(rate(question.id, "up")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await row(question.id)).rating).toBeNull();
  });

  it("loads the Rating with the Message in the Conversation", async () => {
    const { conv, reply, rate, user, deps } = await setup();
    await rate(reply.id, "up");

    const loaded = await chatRpc({ user, deps }).conversation.get({ id: conv.id });

    expect(loaded.messages.find((m) => m.id === reply.id)).toMatchObject({ rating: "up" });
  });
});

describe("a Rating's privacy", () => {
  it("is never sent to the Provider, even in the history of a later reply", async () => {
    const { user, deps, conv, reply } = await setup();
    await chatRpc({ user, deps }).chat.rate({ messageId: reply.id, rating: "down" });
    const fake = createFakeAdapter({ rounds: [round(text("Follow-up"))] });
    const followDeps = createTestDeps({ adapterFor: () => fake.adapter });
    await saveCredentials(followDeps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });

    await (
      await sendAs(
        new Request("http://localhost/api/chat/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [],
            forwardedProps: {
              conversationId: conv.id,
              parentId: reply.id,
              text: "Tell me more",
              attachmentIds: [],
              model: anthropicModel,
              webSearch: false,
            },
          }),
        }),
        user,
        followDeps,
      )
    ).text();

    expect(fake.calls).toHaveLength(1);
    expect(JSON.stringify(fake.calls[0])).toContain("Hello!");
    expect(JSON.stringify(fake.calls[0])).not.toMatch(/rating|rated_at|ratedAt/);
  });

  it("never appears on a Shared link", async () => {
    const { user, deps, conv, reply, rate } = await setup();
    await rate(reply.id, "up");
    const link = await chatRpc({ user, deps }).share.upsert({ conversationId: conv.id });

    const shared = await loadSharedConversation(deps, link.token);

    expect(shared).toBeDefined();
    expect(JSON.stringify(shared)).not.toMatch(/rating|rated_at|ratedAt/);
  });
});

describe("a Rating and the next reply", () => {
  it("leaves the Rating on the old reply when the reply is regenerated, and the new one starts unrated", async () => {
    const { user, deps, conv, question, reply, rate, row } = await setup();
    await rate(reply.id, "up");
    const fake = createFakeAdapter({ rounds: [round(text("Second", " try"))] });
    const regenDeps = createTestDeps({ adapterFor: () => fake.adapter });
    await saveCredentials(regenDeps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });

    await (
      await sendAs(
        new Request("http://localhost/api/chat/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [],
            forwardedProps: {
              conversationId: conv.id,
              parentId: question.id,
              text: undefined,
              attachmentIds: [],
              model: anthropicModel,
              webSearch: false,
            },
          }),
        }),
        user,
        regenDeps,
      )
    ).text();

    const replies = (
      await deps.db.select().from(message).where(eq(message.conversationId, conv.id))
    ).filter((m) => m.role === "assistant");
    const fresh = replies.find((m) => m.id !== reply.id)!;
    expect(fresh).toMatchObject({ rating: null, ratedAt: null, status: "complete" });
    expect(await row(reply.id)).toMatchObject({ rating: "up" });
  });
});

describe("a Hidden reply's Rating", () => {
  it("answers 409 for a Hidden reply and leaves its Rating alone", async () => {
    const { reply, rate, row, deps } = await setup();
    await deps.db
      .update(message)
      .set({ hiddenAt: new Date(), hiddenReason: "policy", rating: "down", ratedAt: new Date() })
      .where(eq(message.id, reply.id));

    await expect(rate(reply.id, "up")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await row(reply.id)).toMatchObject({ rating: "down" });
  });
});
