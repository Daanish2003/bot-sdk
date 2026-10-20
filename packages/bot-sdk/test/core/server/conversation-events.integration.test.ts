import { describe, expect, it } from "vitest";

import type { MemoryUpdatedEvent } from "../../../plugins/memory/shared/changes";
import { hintChanged } from "../../../plugins/bot/server/turn";
import { publishMemoryUpdated } from "../../../plugins/memory/server/notice";
import { insertConversation } from "../../support/conversations";
import { createTestSdk } from "../../support/deps";
import { sendAs } from "../../support/sdk";
import { insertUser } from "../../support/users";

const eventsRequest = (conversationId: string) =>
  new Request(`http://localhost/api/chat/events?conversationId=${conversationId}`);

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

describe("GET /api/chat/events, served by the core (#625)", () => {
  it("streams the assistant's memory_updated event to the owner", async () => {
    const deps = createTestSdk();
    const user = await insertUser();
    const conv = await insertConversation(user);
    const reader = (await sendAs(eventsRequest(conv.id), user, deps)).body!.getReader();

    const event: MemoryUpdatedEvent = { type: "memory_updated", messageId: "m1", changes: [] };
    await publishMemoryUpdated(deps, conv.id, event);

    expect(await nextEvent(reader)).toEqual(event);
    await reader.cancel();
  });

  it("streams a Bot's Turn event on the Bot's Conversation", async () => {
    const deps = createTestSdk();
    const user = await insertUser();
    const conv = await insertConversation(user, { kind: "bot", model: null });
    const response = await sendAs(eventsRequest(conv.id), user, deps);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();

    await hintChanged(deps, conv.id);

    expect(await nextEvent(reader)).toEqual({ type: "changed" });
    await reader.cancel();
  });

  it("refuses a user who does not own the Conversation", async () => {
    const deps = createTestSdk();
    const conv = await insertConversation(await insertUser(), { kind: "bot", model: null });

    const response = await sendAs(eventsRequest(conv.id), await insertUser(), deps);

    expect(response.status).toBe(404);
  });
});
