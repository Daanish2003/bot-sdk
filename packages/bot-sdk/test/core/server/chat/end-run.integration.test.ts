import { message } from "../../../../core/server/db/schema";
import { type StoredPart, storedParts } from "../../../../core/shared/message-parts";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestSdk } from "../../../support/deps";
import { insertUser } from "../../../support/users";
import { type Ending, endRun } from "../../../../core/server/chat/end-run";
import { createHookEmitter, type RunEndEvent } from "../../../../core/server/chat/hooks";
import { START } from "../../../../core/server/chat/run-streams";

/** A running call of each kind a Run's end cancels. */
const runningCalls: StoredPart[] = [
  { type: "web_search", toolCallId: "call-1", query: "q", state: "running", results: [] },
  {
    type: "tool_call",
    toolCallId: "call-1",
    name: "server_time",
    source: "host",
    args: {},
    state: "running",
  },
  {
    type: "generated_image",
    toolCallId: "call-1",
    prompt: "a red bicycle",
    aspectRatio: "square",
    state: "running",
  },
  { type: "knowledge_search", toolCallId: "call-1", query: "q", state: "running", excerpts: [] },
  {
    type: "past_chats_search",
    toolCallId: "call-1",
    query: "q",
    state: "running",
    conversations: [],
  },
];

/** Each ending, with the Message fields, the log's last chunk and the `onRunEnd` it comes out as. */
const endings: Array<{
  name: string;
  ending: Ending;
  row: Partial<typeof message.$inferSelect>;
  lastChunk: Partial<StreamChunk>;
  event: Partial<RunEndEvent>;
}> = [
  {
    name: "complete",
    ending: { status: "complete" },
    row: { status: "complete", error: null },
    lastChunk: { type: EventType.RUN_FINISHED },
    event: { ending: "complete" },
  },
  {
    name: "stopped",
    ending: { status: "stopped" },
    row: { status: "stopped", error: null },
    lastChunk: { type: EventType.RUN_FINISHED },
    event: { ending: "stopped" },
  },
  {
    name: "error",
    ending: { status: "error", error: "Bad key", errorReason: "invalid_key" },
    row: { status: "error", error: "Bad key", errorReason: "invalid_key" },
    lastChunk: { type: EventType.RUN_ERROR, message: "Bad key" },
    event: { ending: "error", reason: "invalid_key" },
  },
  {
    name: "waiting",
    ending: { status: "awaiting_approval", threadId: "thread-1", interruptedRunId: "run-1" },
    row: { status: "awaiting_approval", threadId: "thread-1", interruptedRunId: "run-1" },
    lastChunk: { type: EventType.RUN_FINISHED },
    event: { ending: "awaiting_approval" },
  },
  {
    name: "interrupted",
    ending: { status: "error", error: "interrupted" },
    row: { status: "error", error: "interrupted", errorReason: null },
    lastChunk: { type: EventType.RUN_ERROR, message: "interrupted" },
    event: { ending: "error", reason: "interrupted" },
  },
];

function setup() {
  const events: RunEndEvent[] = [];
  const deps = createTestSdk({
    hooks: createHookEmitter({ onRunEnd: (event) => void events.push(event) }, { error: () => {} }),
  });
  return { deps, events };
}

async function streamingReply(part: StoredPart) {
  const user = await insertUser();
  const conv = await insertConversation(user);
  const reply = await insertMessage({
    conversationId: conv.id,
    role: "assistant",
    text: "",
    status: "streaming",
    parts: storedParts([{ type: "text", text: "Working." }, part]),
  });
  return {
    reply,
    run: {
      messageId: reply.id,
      runId: reply.id,
      userId: user.id,
      conversationId: conv.id,
      model: reply.model ?? "",
      parts: storedParts([{ type: "text", text: "Working." }, part]),
    },
  };
}

describe("endRun", () => {
  describe.each(endings)("ending $name", ({ ending, row, lastChunk, event }) => {
    it.each(runningCalls)("saves the ending and cancels a running $type", async (part) => {
      const { deps, events } = setup();
      const { reply, run } = await streamingReply(part);

      const answered = await endRun(deps, run, ending);

      const [after] = await deps.db.select().from(message).where(eq(message.id, reply.id));
      expect(after).toMatchObject({
        ...row,
        parts: storedParts([
          { type: "text", text: "Working." },
          { ...part, state: "cancelled" } as StoredPart,
        ]),
      });
      const chunks: StreamChunk[] = [];
      for await (const entry of deps.runStreams.read(reply.id, START)) chunks.push(entry.chunk);
      expect(chunks.at(-1)).toMatchObject(lastChunk);
      const expected = {
        messageId: reply.id,
        runId: reply.id,
        conversationId: run.conversationId,
        userId: run.userId,
        hidden: false,
        ...event,
      };
      expect(answered).toMatchObject(expected);
      await vi.waitFor(() => expect(events).toEqual([answered]));
    });
  });

  it("leaves a Message that already ended alone, and answers no event", async () => {
    const { deps, events } = setup();
    const { reply, run } = await streamingReply(runningCalls[0]!);
    await deps.db.update(message).set({ status: "stopped" }).where(eq(message.id, reply.id));

    const answered = await endRun(deps, run, { status: "error", error: "interrupted" });

    const [after] = await deps.db.select().from(message).where(eq(message.id, reply.id));
    expect(after).toMatchObject({ status: "stopped", error: null, parts: reply.parts });
    expect(answered).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([]);
  });
});
