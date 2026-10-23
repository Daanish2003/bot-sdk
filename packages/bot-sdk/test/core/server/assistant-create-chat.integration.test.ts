import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../plugins/models/server/credentials/store";
import { message } from "../../../core/server/db/schema";
import { eq } from "drizzle-orm";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestSdk, createTestChat } from "../../support/assistant";
import { createFakeAdapter, round, text } from "../../support/fake-adapter";
import { insertUser } from "../../support/users";
import { getTestDb } from "../../support/test-database";

describe("the chat handler, with the assistant", () => {
  it("streams a Run through the handler and saves its reply", async () => {
    const user = await insertUser();
    const fake = createFakeAdapter({ rounds: [round(text("Hello", " there!"))] });
    const deps = createTestSdk({ adapterFor: () => fake.adapter });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });
    // A titled Conversation, so no automatic title call takes the scripted adapter.
    const conv = await insertConversation(user, { title: "Test Conversation" });
    const client = createTestChat({ user, deps });

    const response = await client.fetch(
      new Request(client.chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "Hi",
            attachmentIds: [],
            model: "anthropic:claude-sonnet-5-5",
            webSearch: false,
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"delta":" there!"');
    const replies = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.conversationId, conv.id));
    expect(replies.map(({ role, status }) => [role, status]).sort()).toEqual([
      ["assistant", "complete"],
      ["user", "complete"],
    ]);
    // The reply's heartbeat was set when its Run started (ADR 0006).
    expect(replies.find(({ role }) => role === "assistant")?.heartbeatAt).toBeInstanceOf(Date);
  });

  it("serves a Shared link to a caller without a user", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const conv = await insertConversation(owner, { title: "Recursive CTEs" });
    await insertMessage({ conversationId: conv.id, role: "user", text: "Hi", active: true });
    const link = await createTestChat({ user: owner, deps }).rpc.share.upsert({
      conversationId: conv.id,
    });

    const shared = await createTestChat({ user: null, deps }).rpc.share.get({ token: link.token });

    expect(shared.title).toBe("Recursive CTEs");
    expect(shared.messages.map(({ parts }) => parts)).toEqual([[{ type: "text", content: "Hi" }]]);
  });
});
