import { message } from "../../../../core/server/db/schema";
import { storedParts } from "../../../../plugins/assistant/shared/message-parts";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestSdk } from "../../../support/deps";
import { insertUser } from "../../../support/users";
import { reapStaleRuns, startRun } from "../../../../plugins/assistant/server/chat/run";
import { freeMeter } from "../../../../plugins/models/server/meter";
import type { RunPlan } from "../../../../plugins/assistant/server/chat/run-plan";
import { findModel } from "../../../../plugins/models/shared/models";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { START } from "../../../../core/server/chat/run-streams";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { assistantState } from "../../../../plugins/assistant/server/state";

async function rowOf(deps: ReturnType<typeof createTestSdk>, id: string) {
  const [row] = await deps.db.select().from(message).where(eq(message.id, id));
  return row!;
}

async function logOf(deps: ReturnType<typeof createTestSdk>, id: string) {
  const chunks: StreamChunk[] = [];
  for await (const entry of assistantState(deps).runStreams.read(id, START))
    chunks.push(entry.chunk);
  return chunks;
}

describe("reapStaleRuns", () => {
  it("ends a streaming Message with a stale heartbeat as error, interrupted, keeping its text", async () => {
    const deps = createTestSdk();
    const user = await insertUser();
    const first = await insertConversation(user);
    const second = await insertConversation(await insertUser());
    // Set explicitly against the reaper's clock: the database's default timestamps can run ahead.
    const now = new Date("2026-10-09T12:00:00Z");
    const staleHeartbeat = new Date(now.getTime() - 60_000);
    const half = await insertMessage({
      conversationId: first.id,
      role: "assistant",
      text: "Half",
      status: "streaming",
      heartbeatAt: staleHeartbeat,
    });
    const neverBeat = await insertMessage({
      conversationId: second.id,
      role: "assistant",
      text: "",
      status: "streaming",
      heartbeatAt: null,
    });

    await reapStaleRuns(deps, now);

    expect(await rowOf(deps, half.id)).toMatchObject({
      status: "error",
      error: "interrupted",
      errorReason: null,
      parts: { parts: [{ type: "text", text: "Half" }] },
    });
    expect(await rowOf(deps, neverBeat.id)).toMatchObject({
      status: "error",
      error: "interrupted",
    });
  });

  it("leaves a streaming Message with a fresh heartbeat, and Messages that ended, alone", async () => {
    const deps = createTestSdk();
    const user = await insertUser();
    const conv = await insertConversation(user);
    const now = new Date("2026-10-09T12:00:00Z");
    const done = await insertMessage({ conversationId: conv.id, role: "assistant", text: "Done" });
    const stopped = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "Sto",
      status: "stopped",
      heartbeatAt: new Date(now.getTime() - 60_000),
    });
    const live = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "Li",
      status: "streaming",
      // Within the 30 s lease.
      heartbeatAt: new Date(now.getTime() - 5_000),
    });

    await reapStaleRuns(deps, now);

    expect(await rowOf(deps, done.id)).toMatchObject({ status: "complete", error: null });
    expect(await rowOf(deps, stopped.id)).toMatchObject({ status: "stopped", error: null });
    expect(await rowOf(deps, live.id)).toMatchObject({ status: "streaming", error: null });
  });

  it("closes the log of a reaped Message with a terminal error chunk", async () => {
    const deps = createTestSdk();
    const conv = await insertConversation(await insertUser());
    const now = new Date("2026-10-09T12:00:00Z");
    const row = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "",
      status: "streaming",
      heartbeatAt: new Date(now.getTime() - 60_000),
    });

    await reapStaleRuns(deps, now);

    const chunks = await logOf(deps, row.id);
    expect(chunks.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: "interrupted" });
  });

  it("closes a past-chats search still running in a reaped reply as cancelled", async () => {
    const deps = createTestSdk();
    const conv = await insertConversation(await insertUser());
    const now = new Date("2026-10-09T12:00:00Z");
    const stale = { status: "streaming" as const, heartbeatAt: new Date(now.getTime() - 60_000) };
    const pastChats = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "",
      ...stale,
      parts: storedParts([
        {
          type: "past_chats_search",
          toolCallId: "call-1",
          query: "q",
          state: "running",
          conversations: [],
        },
      ]),
    });

    await reapStaleRuns(deps, now);

    expect(await rowOf(deps, pastChats.id)).toMatchObject({
      status: "error",
      parts: { parts: [{ type: "past_chats_search", state: "cancelled" }] },
    });
  });

  it("still reaps a reply whose stored parts don't parse", async () => {
    const deps = createTestSdk();
    const conv = await insertConversation(await insertUser());
    const now = new Date("2026-10-09T12:00:00Z");
    const row = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "",
      status: "streaming",
      heartbeatAt: new Date(now.getTime() - 60_000),
      parts: { schemaVersion: 99 } as never,
    });

    await reapStaleRuns(deps, now);

    expect(await rowOf(deps, row.id)).toMatchObject({ status: "error", error: "interrupted" });
  });
});

describe("startRun", () => {
  it("writes heartbeat_at every snapshot interval, even while the Run waits on the model", async () => {
    const user = await insertUser();
    // Titled, so the finished Run doesn't ask the scripted adapter for a title.
    const conv = await insertConversation(user, { title: "Titled" });
    const held = createFakeAdapter({ rounds: [round(text("Hi"))], manual: true });
    const deps = createTestSdk({ limits: { snapshotIntervalMs: 20, runCapMs: 5_000 } });
    const row = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "",
      status: "streaming",
      heartbeatAt: new Date(Date.now() - 60_000),
    });

    const startedAt = Date.now();
    const plan: RunPlan = {
      replyId: row.id,
      model: findModel("anthropic:claude-sonnet-5-5")!,
      context: { userId: "user", conversationId: "conversation" },
      effort: undefined,
      offered: {
        webSearch: null,
        fetchUrl: false,
        pastChats: null,
        image: null,
        artifacts: false,
        hostTools: [],
        mcp: undefined,
      },
      adapter: held.adapter,
      messages: [],
      systemPrompts: [],
      modelOptions: undefined,
      meter: freeMeter,
      added: { parts: undefined, attachments: [] },
      tools: () => [],
    };
    await startRun(deps, plan, {});
    // Nothing is released, so no chunk arrives: only the timer can write the heartbeat.
    await expect
      .poll(async () => (await rowOf(deps, row.id)).heartbeatAt?.getTime() ?? 0)
      .toBeGreaterThanOrEqual(startedAt);

    await held.releaseAll();
    await expect.poll(async () => (await rowOf(deps, row.id)).status).toBe("complete");
  });
});
