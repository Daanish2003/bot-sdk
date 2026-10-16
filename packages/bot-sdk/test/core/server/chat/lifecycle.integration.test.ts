import { message } from "../../../../core/server/db/schema/chat";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createLifecycle } from "../../../../core/server/lifecycle";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { insertUser } from "../../../support/users";
import { createTestChat } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Message's status, read straight from the test database. */
async function statusOf(id: string) {
  const [row] = await getTestDb().select().from(message).where(eq(message.id, id));
  return row?.status;
}

/** A streaming assistant Message whose heartbeat is `ageMs` old by the host's clock. */
function staleReply(conversationId: string, ageMs = 60_000) {
  return insertMessage({
    conversationId,
    role: "assistant",
    text: "",
    status: "streaming",
    heartbeatAt: new Date(Date.now() - ageMs),
  });
}

describe("the lifecycle timer", () => {
  it("reaps as it starts, and again on every interval", async () => {
    const deps = createTestDeps({ limits: { ...createTestDeps().limits, reapIntervalMs: 20 } });
    const conv = await insertConversation(await insertUser());
    const first = await staleReply(conv.id);
    const lifecycle = createLifecycle(deps);

    await lifecycle.start();
    expect(await statusOf(first.id)).toBe("error");

    const later = await staleReply(conv.id);
    await expect.poll(() => statusOf(later.id)).toBe("error");
    await lifecycle.stop();
  });

  it("clears the timer on stop", async () => {
    const deps = createTestDeps({ limits: { ...createTestDeps().limits, reapIntervalMs: 20 } });
    const conv = await insertConversation(await insertUser());
    const lifecycle = createLifecycle(deps);
    await lifecycle.start();
    await lifecycle.stop();

    const after = await staleReply(conv.id);
    await sleep(100);

    expect(await statusOf(after.id)).toBe("streaming");
  });
});

describe("stop()", () => {
  async function signedInWithKey() {
    const user = await insertUser();
    await saveCredentials(createTestDeps(), user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });
    return user;
  }

  const runPost = (chatUrl: string, conversationId: string) =>
    new Request(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        forwardedProps: {
          conversationId,
          parentId: null,
          text: "Hi",
          attachmentIds: [],
          model: "anthropic:claude-sonnet-5-5",
          webSearch: false,
        },
      }),
    });

  it("refuses new Runs with 503, lets a running Run finish, then ends", async () => {
    const user = await signedInWithKey();
    const conv = await insertConversation(user, { title: "Titled" });
    const held = createFakeAdapter({ rounds: [round(text("Done."))], manual: true });
    const deps = createTestDeps({ adapterFor: () => held.adapter });
    const lifecycle = createLifecycle(deps);
    const client = createTestChat({ user, deps });
    const running = await client.fetch(runPost(client.chatUrl, conv.id));
    expect(running.status).toBe(200);

    const stopping = lifecycle.stop();
    const refused = await client.fetch(runPost(client.chatUrl, conv.id));
    expect(refused.status).toBe(503);

    await held.releaseAll();
    expect(await running.text()).toContain("Done.");
    await stopping;
    const replies = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.conversationId, conv.id));
    expect(replies.find((row) => row.role === "assistant")).toMatchObject({ status: "complete" });
  });

  it("ends a Run still going after drainMs as interrupted, and closes its log", async () => {
    const user = await signedInWithKey();
    const conv = await insertConversation(user, { title: "Titled" });
    const held = createFakeAdapter({ rounds: [round(text("Never."))], manual: true });
    const deps = createTestDeps({
      adapterFor: () => held.adapter,
      limits: { ...createTestDeps().limits, drainMs: 100 },
    });
    const lifecycle = createLifecycle(deps);
    const client = createTestChat({ user, deps });
    const running = await client.fetch(runPost(client.chatUrl, conv.id));

    await lifecycle.stop();

    expect(await running.text()).toContain("interrupted");
    const replies = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.conversationId, conv.id));
    expect(replies.find((row) => row.role === "assistant")).toMatchObject({
      status: "error",
      error: "interrupted",
    });
  });
});
