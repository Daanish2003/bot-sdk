import { and, eq } from "drizzle-orm";
import { type AnyTextAdapter, EventType, type StreamChunk, toolDefinition } from "@tanstack/ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createBotSdkClient } from "../../../../core/client/chat-client";
import { assistantClient } from "../../../../plugins/assistant/client/index";
import { modelsClient } from "../../../../plugins/models/client/index";
import {
  type EventHooks,
  createHookEmitter,
  type RunEndEvent,
} from "../../../../core/server/chat/hooks";
import { createChatHandler } from "../../../../plugins/assistant/server/over";
import type { HostToolContext } from "../../../../plugins/assistant/server/chat/host-tools";
import type { HostProvider } from "../../../../plugins/assistant/server/deps";
import { message, usage } from "../../../../core/server/db/schema";
import { exportUserData } from "../../../../plugins/assistant/server/export-user";
import { START } from "../../../../core/server/chat/run-streams";
import { insertConversation } from "../../../support/conversations";
import { createTestSdk } from "../../../support/deps";
import {
  createFakeAdapter,
  round,
  runError,
  text,
  thinking,
  toolCall,
} from "../../../support/fake-adapter";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { assistantState } from "../../../../plugins/assistant/server/state";

const basePath = "/api/chat";
/** A Host tool that needs Approval, so a Run ends waiting for it (ADR 0008). */
const sendMail = toolDefinition({
  name: "send_mail",
  description: "Sends an email.",
  inputSchema: z.object({ to: z.string(), body: z.string() }),
  needsApproval: true,
}).server<HostToolContext>(async () => ({ sent: true }));
const hostModel = "anthropic:claude-sonnet-5-5";
const hostProvider: HostProvider = {
  provider: "anthropic",
  credentials: { apiKey: "sk-ant-host-key" },
  models: [
    {
      modelId: "claude-sonnet-5-5",
      maxOutputTokens: 1_000,
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    },
  ],
};

/** A Host's check that flags any reply text containing `word`, and lets every input through. */
const flags =
  (word: string): NonNullable<EventHooks["moderate"]> =>
  (check) =>
    check.phase === "output" && check.text.includes(word)
      ? { allow: false, reason: "Policy" }
      : { allow: true };

/** Test deps whose hooks are `hooks` and whose Runs answer with `fake`. */
function moderatedDeps(
  hooks: EventHooks,
  fake: { adapter: AnyTextAdapter },
  logger: { error: (...args: unknown[]) => void } = { error: () => {} },
) {
  return createTestSdk({
    hostProviders: [hostProvider],
    hooks: createHookEmitter(hooks, logger),
    adapterFor: () => fake.adapter,
  });
}

/** A Run POST for `conversationId`; `command` overrides the default send (a regenerate has no text). */
function commandRequest(
  conversationId: string,
  command: { parentId?: string | null; text?: string } = {},
) {
  return new Request(`http://localhost${basePath}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [],
      forwardedProps: {
        conversationId,
        parentId: null,
        text: "Hi",
        attachmentIds: [],
        model: hostModel,
        webSearch: false,
        ...command,
      },
    }),
  });
}

/** The assistant Message a Run wrote in a Conversation. */
async function replyOf(conversationId: string) {
  const [row] = await getTestDb()
    .select()
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.role, "assistant")));
  if (!row) throw new Error("No reply Message");
  return row;
}

/** The chunks a Run's log holds, from its first entry (ADR 0006). */
async function logChunks(deps: ReturnType<typeof createTestSdk>, runId: string) {
  const chunks: StreamChunk[] = [];
  for await (const entry of assistantState(deps).runStreams.read(runId, START))
    chunks.push(entry.chunk);
  return chunks;
}

/** Whether a chunk is the `moderated` custom chunk a hidden reply's Run log ends with (#269). */
const isModerated = (chunk: StreamChunk) =>
  chunk.type === EventType.CUSTOM && chunk.name === "moderated";

describe("the moderate hook on the reply", () => {
  it("lets the user send again after a hidden reply that was waiting for Approval", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Hidden and waiting" });
    const fake = createFakeAdapter({
      rounds: [
        round(
          text("Forbidden words"),
          toolCall({ name: "send_mail", input: { to: "a@b.c", body: "Hi" } }),
        ),
        round(text("Next")),
      ],
    });
    const deps = createTestSdk({
      hostProviders: [hostProvider],
      hooks: createHookEmitter({ moderate: flags("Forbidden") }, { error: () => {} }),
      adapterFor: () => fake.adapter,
      tools: [sendMail],
    });
    await (await sendAs(commandRequest(conv.id), user, deps)).text();
    const waiting = await replyOf(conv.id);

    const response = await sendAs(
      commandRequest(conv.id, { parentId: waiting.id, text: "Again" }),
      user,
      deps,
    );

    expect(response.status).toBe(200);
    await response.text();
  });

  it("reads a flagged reply back as hidden with no text, through the RPC, the Shared link and the export", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Hidden" });
    const fake = createFakeAdapter({ rounds: [round(text("Forbidden", " words"))] });
    const deps = moderatedDeps({ moderate: flags("Forbidden") }, fake);

    await (await sendAs(commandRequest(conv.id), user, deps)).text();

    const reply = await replyOf(conv.id);
    const rpc = chatRpc({ user, deps });
    const { messages } = await rpc.conversation.get({ id: conv.id });
    const link = await rpc.share.upsert({ conversationId: conv.id });
    const shared = await chatRpc({ deps }).share.get({ token: link.token });
    const exported = await exportUserData(deps, user.id);
    expect(messages.find((m) => m.id === reply.id)).toMatchObject({
      status: "complete",
      hidden: true,
      parts: [],
    });
    expect(shared.messages.find((m) => m.id === reply.id)).toMatchObject({
      hidden: true,
      parts: [],
    });
    expect(exported.conversations[0]?.messages.find((m) => m.id === reply.id)).toMatchObject({
      hidden: true,
    });
    for (const read of [messages, shared, exported]) {
      expect(JSON.stringify(read)).not.toContain("Forbidden");
    }
  });

  it("leaves a hidden reply out of the history the next Run sends", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "History" });
    const fake = createFakeAdapter({
      rounds: [round(text("Forbidden words")), round(text("Next"))],
    });
    const deps = moderatedDeps({ moderate: flags("Forbidden") }, fake);
    await (await sendAs(commandRequest(conv.id), user, deps)).text();
    const reply = await replyOf(conv.id);

    await (
      await sendAs(commandRequest(conv.id, { parentId: reply.id, text: "Again" }), user, deps)
    ).text();

    expect(fake.calls).toHaveLength(2);
    const sent = JSON.stringify(fake.calls[1]!.messages);
    expect(sent).toContain("Again");
    expect(sent).not.toContain("Forbidden");
  });

  it("still records the usage and fires onRunEnd with hidden set", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Usage" });
    const fake = createFakeAdapter({ rounds: [round(text("Forbidden words"))] });
    const onRunEnd = vi.fn<(run: RunEndEvent) => unknown>();
    const deps = moderatedDeps({ moderate: flags("Forbidden"), onRunEnd }, fake);

    await (await sendAs(commandRequest(conv.id), user, deps)).text();

    expect(await getTestDb().select().from(usage).where(eq(usage.userId, user.id))).toHaveLength(1);
    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ ending: "complete", hidden: true }),
    );
  });

  it("checks the partial text of an errored Run, without its reasoning", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Errored" });
    const fake = createFakeAdapter({
      rounds: [
        round(thinking("Private thoughts"), text("Partial words"), runError("Provider down")),
      ],
    });
    const moderate = vi.fn<NonNullable<EventHooks["moderate"]>>(() => ({ allow: true }));
    const deps = moderatedDeps({ moderate }, fake);

    await (await sendAs(commandRequest(conv.id), user, deps)).text();

    const reply = await replyOf(conv.id);
    expect(moderate).toHaveBeenCalledWith({
      phase: "output",
      userId: user.id,
      conversationId: conv.id,
      messageId: reply.id,
      runId: reply.id,
      onHostCredentials: true,
      text: "Partial words",
    });
  });

  it("checks the text a stopped Run produced before the Stop", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Stopped text" });
    const fake = createFakeAdapter({ rounds: [round(text("Partial words"))], manual: true });
    const moderate = vi.fn<NonNullable<EventHooks["moderate"]>>(() => ({ allow: true }));
    const deps = moderatedDeps({ moderate }, fake);
    const chat = createChatHandler(deps, {
      basePath,
      getUser: () => ({ id: user.id }),
      logger: { error: () => {} },
    });

    const response = await chat(commandRequest(conv.id));
    await fake.release(3);
    const reply = await replyOf(conv.id);
    await createBotSdkClient({
      plugins: [modelsClient(), assistantClient()],
      baseUrl: `http://localhost${basePath}`,
      fetch: chat,
    }).rpc.chat.stop({ messageId: reply.id });
    await response.text();

    expect(moderate).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "output", text: "Partial words" }),
    );
  });

  it("does not check a Run that produced no text", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Empty" });
    const fake = createFakeAdapter({ rounds: [round(runError("Provider down"))] });
    const moderate = vi.fn<NonNullable<EventHooks["moderate"]>>(() => ({ allow: true }));
    const deps = moderatedDeps({ moderate }, fake);

    await (await sendAs(commandRequest(conv.id), user, deps)).text();

    expect(moderate.mock.calls.filter(([check]) => check.phase === "output")).toEqual([]);
  });

  it("regenerates a hidden reply as a new sibling reply", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Regenerate" });
    const fake = createFakeAdapter({
      rounds: [round(text("Forbidden words")), round(text("Fine answer"))],
    });
    const deps = moderatedDeps({ moderate: flags("Forbidden") }, fake);
    await (await sendAs(commandRequest(conv.id), user, deps)).text();
    const hidden = await replyOf(conv.id);

    await (
      await sendAs(
        commandRequest(conv.id, { parentId: hidden.parentId, text: undefined }),
        user,
        deps,
      )
    ).text();

    const { messages } = await chatRpc({ user, deps }).conversation.get({ id: conv.id });
    const reply = messages.at(-1);
    expect(reply).toMatchObject({ role: "assistant", hidden: false, status: "complete" });
    expect(reply?.id).not.toBe(hidden.id);
    expect(reply?.siblings.count).toBe(2);
    expect(JSON.stringify(reply?.parts)).toContain("Fine answer");
  });

  it("lets the reply through and logs when the output check throws", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Throws" });
    const fake = createFakeAdapter({ rounds: [round(text("Forbidden words"))] });
    const error = vi.fn();
    const deps = moderatedDeps(
      {
        moderate: (check) => {
          if (check.phase === "output") throw new Error("vendor down");
          return { allow: true };
        },
      },
      fake,
      { error },
    );

    await (await sendAs(commandRequest(conv.id), user, deps)).text();

    const { messages } = await chatRpc({ user, deps }).conversation.get({ id: conv.id });
    expect(messages.at(-1)).toMatchObject({ hidden: false, status: "complete" });
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });

  it("lets the reply through and logs when the output check takes longer than 10 seconds", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Slow output" });
    const fake = createFakeAdapter({ rounds: [round(text("Forbidden words"))] });
    const error = vi.fn();
    const moderate = vi.fn<NonNullable<EventHooks["moderate"]>>((check) =>
      check.phase === "output" ? new Promise<never>(() => {}) : { allow: true },
    );
    const deps = moderatedDeps({ moderate }, fake, { error });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = sendAs(commandRequest(conv.id), user, deps);
      await vi.waitFor(() =>
        expect(moderate.mock.calls.some(([check]) => check.phase === "output")).toBe(true),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await (await pending).text();
    } finally {
      vi.useRealTimers();
    }

    const { messages } = await chatRpc({ user, deps }).conversation.get({ id: conv.id });
    expect(messages.at(-1)).toMatchObject({ hidden: false, status: "complete" });
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });

  it("a flagged Run's log ends with the moderated chunk, after its own ending (#269)", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Moderated log" });
    const fake = createFakeAdapter({ rounds: [round(text("Forbidden", " words"))] });
    const deps = moderatedDeps({ moderate: flags("Forbidden") }, fake);

    await (await sendAs(commandRequest(conv.id), user, deps)).text();

    const chunks = await logChunks(deps, (await replyOf(conv.id)).id);
    expect(chunks.at(-1)).toMatchObject({ type: "CUSTOM", name: "moderated" });
    expect(chunks.at(-2)?.type).toBe(EventType.RUN_FINISHED);
  });

  it("an unflagged Run's log has no moderated chunk (#269)", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Unflagged log" });
    const fake = createFakeAdapter({ rounds: [round(text("Fine answer"))] });
    const deps = moderatedDeps({ moderate: flags("Forbidden") }, fake);

    await (await sendAs(commandRequest(conv.id), user, deps)).text();

    const chunks = await logChunks(deps, (await replyOf(conv.id)).id);
    expect(chunks.some(isModerated)).toBe(false);
  });

  it("a Host without a moderate hook writes no moderated chunk (#269)", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "No hook log" });
    const fake = createFakeAdapter({ rounds: [round(text("Forbidden", " words"))] });
    const deps = createTestSdk({ hostProviders: [hostProvider], adapterFor: () => fake.adapter });

    await (await sendAs(commandRequest(conv.id), user, deps)).text();

    const chunks = await logChunks(deps, (await replyOf(conv.id)).id);
    expect(chunks.some(isModerated)).toBe(false);
  });

  it("a reply that spans two Runs is hidden whole when its second Run is flagged (#269)", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Two Runs" });
    const fake = createFakeAdapter({
      rounds: [
        round(
          text("Checking"),
          toolCall({ name: "send_mail", input: { to: "a@b.c", body: "Hi" } }),
        ),
        round(text("Forbidden", " words")),
      ],
    });
    const deps = createTestSdk({
      hostProviders: [hostProvider],
      hooks: createHookEmitter({ moderate: flags("Forbidden") }, { error: () => {} }),
      adapterFor: () => fake.adapter,
      tools: [sendMail],
    });
    await (await sendAs(commandRequest(conv.id), user, deps)).text();
    const waiting = await replyOf(conv.id);

    await chatRpc({ user, deps }).chat.decide({ messageId: waiting.id, approved: true });
    await (
      await sendAs(
        new Request(`http://localhost${basePath}/run?runId=${waiting.id}`, { method: "GET" }),
        user,
        deps,
      )
    ).text();

    const { messages } = await chatRpc({ user, deps }).conversation.get({ id: conv.id });
    expect(messages.find((m) => m.id === waiting.id)).toMatchObject({ hidden: true, parts: [] });
    const row = await replyOf(conv.id);
    expect(JSON.stringify(row.parts)).not.toContain("Checking");
    expect(JSON.stringify(row.parts)).not.toContain("Forbidden");
    expect((await logChunks(deps, `${waiting.id}:2`)).at(-1)).toMatchObject({
      type: "CUSTOM",
      name: "moderated",
    });
  });
});
