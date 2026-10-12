import { and, asc, eq } from "drizzle-orm";
import { type AnyTextAdapter, toolDefinition } from "@tanstack/ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createChatClient } from "../../../../core/client/chat-client";
import type { HostToolContext } from "../../../../core/server/chat/host-tools";
import { createHookEmitter, type RunEndEvent } from "../../../../core/server/chat/hooks";
import { reapStaleRuns } from "../../../../core/server/chat/run";
import {
  createChat,
  createChatHandler,
  type CreateChatOptions,
} from "../../../../core/server/create-chat";
import { deleteAllConversations, deleteUserData } from "../../../../core/server/delete-user";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { conversation, message, project } from "../../../../core/server/db/schema/chat";
import { usage } from "../../../../core/server/db/schema/usage";
import type { HostProvider } from "../../../../core/server/deps";
import { createLifecycle } from "../../../../core/server/lifecycle";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { createTestDeps, testKeyEncryptionSecret } from "../../../support/deps";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createFakeAdapter, round, runError, text, toolCall } from "../../../support/fake-adapter";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb, testDatabaseUrl } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

// The Run's adapter: the handler's `createChat` builds its adapters itself, so the module hands
// it the scripted fake for each test.
const scripted = vi.hoisted(() => ({ adapter: undefined as unknown as AnyTextAdapter }));
vi.mock("../../../../core/server/chat/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../core/server/chat/adapters")>()),
  adapterFor: () => scripted.adapter,
}));

const basePath = "/api/chat";
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

/** A `createChat` over the test database, with the Host's hooks and logger. */
function chatWith(
  options: Partial<CreateChatOptions> & { userId: string },
): ReturnType<typeof createChat> {
  const { userId, ...rest } = options;
  return createChat({
    databaseUrl: testDatabaseUrl,
    getUser: () => ({ id: userId }),
    keyEncryptionSecrets: [testKeyEncryptionSecret],
    basePath,
    hostProviders: [hostProvider],
    logger: { error: () => {} },
    ...rest,
  });
}

/** Sends one Run for `conversationId` through the handler and reads its stream to the end. */
async function runOnce(
  handler: ReturnType<typeof createChat>["handler"],
  conversationId: string,
  model = hostModel,
) {
  const response = await handler(
    new Request(`http://localhost${basePath}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        forwardedProps: {
          conversationId,
          parentId: null,
          text: "Hi",
          attachmentIds: [],
          model,
          webSearch: false,
        },
      }),
    }),
  );
  await response.text();
}

async function replyStatus(conversationId: string) {
  const rows = await getTestDb()
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.find((row) => row.role === "assistant")?.status;
}

describe("the onUsage hook", () => {
  it("fires once with the usage row as written, after the insert", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Hooked" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const onUsage = vi.fn();
    const chat = chatWith({ userId: user.id, hooks: { onUsage } });

    await runOnce(chat.handler, conv.id);

    const rows = await getTestDb().select().from(usage).where(eq(usage.userId, user.id));
    expect(rows).toHaveLength(1);
    await vi.waitFor(() => expect(onUsage).toHaveBeenCalledTimes(1));
    expect(onUsage).toHaveBeenCalledWith(rows[0]);
  });

  it("never fires for a Run on the user's own credentials", async () => {
    const user = await insertUser();
    const deps = createTestDeps();
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });
    const conv = await insertConversation(user, { title: "Own key" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const onUsage = vi.fn();
    const chat = chatWith({ userId: user.id, hostProviders: [], hooks: { onUsage } });

    await runOnce(chat.handler, conv.id);

    expect(await replyStatus(conv.id)).toBe("complete");
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("logs a hook that throws through the Host's logger and still completes the Run", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Throws" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const error = vi.fn();
    const chat = chatWith({
      userId: user.id,
      logger: { error },
      hooks: {
        onUsage: () => {
          throw new Error("hook threw");
        },
      },
    });

    await runOnce(chat.handler, conv.id);

    expect(await replyStatus(conv.id)).toBe("complete");
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith(expect.any(String), new Error("hook threw"));
  });

  it("logs a hook that rejects through the Host's logger and still completes the Run", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Rejects" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const error = vi.fn();
    const chat = chatWith({
      userId: user.id,
      logger: { error },
      hooks: { onUsage: () => Promise.reject(new Error("hook rejected")) },
    });

    await runOnce(chat.handler, conv.id);

    expect(await replyStatus(conv.id)).toBe("complete");
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith(expect.any(String), new Error("hook rejected"));
  });

  it("does not delay the Run's response while a hook never resolves", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Hangs" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const chat = chatWith({
      userId: user.id,
      hooks: { onUsage: () => new Promise(() => {}) },
    });

    await runOnce(chat.handler, conv.id);

    expect(await replyStatus(conv.id)).toBe("complete");
  });
});

/** A Host's `onRunEnd` mock, and test deps whose emitter calls it. */
type RunEndMock = ReturnType<typeof vi.fn<(run: RunEndEvent) => unknown>>;
function depsWithRunEnd(
  onRunEnd: RunEndMock,
  overrides: Parameters<typeof createTestDeps>[0] = {},
) {
  return createTestDeps({
    hostProviders: [hostProvider],
    hooks: createHookEmitter({ onRunEnd }, { error: () => {} }),
    ...overrides,
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

/** A Run POST for `conversationId` on the Host's Model, as the handler reads it. */
function runRequest(conversationId: string) {
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
      },
    }),
  });
}

/** A streaming reply whose owner stopped heartbeating long ago: no process is left to end it. */
function orphanedReply(conversationId: string) {
  return insertMessage({
    conversationId,
    role: "assistant",
    text: "",
    status: "streaming",
    model: hostModel,
    heartbeatAt: new Date(Date.now() - 60 * 60_000),
  });
}

/** The send-approval tool of the approval tests: it needs Approval, and `runs` records each real run. */
function sendMail(runs: Array<{ to: string; body: string }>) {
  return toolDefinition({
    name: "send_mail",
    description: "Sends an email.",
    inputSchema: z.object({ to: z.string(), body: z.string() }),
    needsApproval: true,
  }).server<HostToolContext>(async (args) => {
    runs.push(args);
    return { sent: true, to: args.to };
  });
}

/** The database, with the delete of `failing` table failing, so its transaction rolls back. */
function failingDeleteOf(
  db: ReturnType<typeof getTestDb>,
  failing: unknown,
): ReturnType<typeof getTestDb> {
  return new Proxy(db, {
    get: (target, key) => {
      if (key !== "transaction") return Reflect.get(target, key, target);
      return (run: (tx: unknown) => Promise<unknown>) =>
        target.transaction((tx) =>
          run(
            new Proxy(tx as object, {
              get: (txTarget, txKey) => {
                if (txKey !== "delete") return Reflect.get(txTarget, txKey, txTarget);
                return (table: unknown) =>
                  table === failing
                    ? { where: () => Promise.reject(new Error("delete failed")) }
                    : (txTarget as typeof db).delete(table as never);
              },
            }),
          ),
        );
    },
  });
}

describe("the onRunEnd hook", () => {
  it("fires once for a complete Run, after its ending is written, without the reply's text", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Ends" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello", " there"))] }).adapter;
    const endingSeen: Array<string | undefined> = [];
    const onRunEnd = vi.fn<(run: RunEndEvent) => Promise<void>>(async () => {
      endingSeen.push((await replyOf(conv.id)).status);
    });
    const chat = chatWith({ userId: user.id, hooks: { onRunEnd } });

    await runOnce(chat.handler, conv.id);

    const reply = await replyOf(conv.id);
    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith({
      userId: user.id,
      conversationId: conv.id,
      messageId: reply.id,
      runId: reply.id,
      ending: "complete",
      model: hostModel,
      onHostCredentials: true,
      hidden: false,
    });
    expect(endingSeen).toEqual(["complete"]);
    expect(JSON.stringify(onRunEnd.mock.calls)).not.toContain("Hello there");
  });

  it("fires as an error with the Provider's reason when a Run fails", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Fails" });
    scripted.adapter = createFakeAdapter({
      rounds: [round(runError("Too many requests", "429"))],
    }).adapter;
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const chat = chatWith({ userId: user.id, hooks: { onRunEnd } });

    await runOnce(chat.handler, conv.id);

    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ ending: "error", reason: "rate_limited" }),
    );
  });

  it("fires as stopped when a Run is stopped through the chat RPC", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Stopped" });
    scripted.adapter = createFakeAdapter({
      rounds: [round(text("Hi"))],
      manual: true,
    }).adapter;
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const chat = chatWith({ userId: user.id, hooks: { onRunEnd } });

    const response = await chat.handler(runRequest(conv.id));
    const reply = await replyOf(conv.id);
    await createChatClient({
      baseUrl: `http://localhost${basePath}`,
      fetch: chat.handler,
    }).rpc.chat.stop({ messageId: reply.id });
    await response.text();

    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ runId: reply.id, ending: "stopped" }),
    );
    expect(onRunEnd.mock.calls[0]?.[0]).not.toHaveProperty("reason");
  });

  it("fires as an error with reason timed_out when a Run hits its cap", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Slow" });
    const held = createFakeAdapter({ rounds: [round(text("Hi"))], manual: true });
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = depsWithRunEnd(onRunEnd, {
      adapterFor: () => held.adapter,
      limits: { runCapMs: 50 },
    });

    const response = await sendAs(runRequest(conv.id), user, deps);
    await response.text();

    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ ending: "error", reason: "timed_out" }),
    );
  });

  it("fires as an error with reason interrupted for a Run that stop() cuts off", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Shutdown" });
    const held = createFakeAdapter({ rounds: [round(text("Hi"))], manual: true });
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = depsWithRunEnd(onRunEnd, {
      adapterFor: () => held.adapter,
      limits: { drainMs: 20 },
    });

    const response = await sendAs(runRequest(conv.id), user, deps);
    await createLifecycle(deps).stop();
    await response.text();

    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ ending: "error", reason: "interrupted" }),
    );
  });

  it("fires for the Run that waits for an Approval, then for its follow-on Run with its own id", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Approval" });
    const runs: Array<{ to: string; body: string }> = [];
    const fake = createFakeAdapter({
      rounds: [
        round(toolCall({ id: "call_mail", name: "send_mail", input: { to: "a@b.c", body: "Hi" } })),
        round(text("Sent")),
      ],
    });
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = depsWithRunEnd(onRunEnd, {
      adapterFor: () => fake.adapter,
      tools: [sendMail(runs)],
    });

    const response = await sendAs(runRequest(conv.id), user, deps);
    await response.text();
    const reply = await replyOf(conv.id);
    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: reply.id, ending: "awaiting_approval" }),
    );

    await chatRpc({ user, deps }).chat.decide({ messageId: reply.id, approved: true });

    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(2));
    expect(onRunEnd).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: reply.id, runId: `${reply.id}:2`, ending: "complete" }),
    );
  });

  it("fires for a Run the reaper ends as interrupted", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Reaped" });
    const reply = await orphanedReply(conv.id);
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = depsWithRunEnd(onRunEnd);

    await reapStaleRuns(deps, new Date());

    expect(onRunEnd).toHaveBeenCalledWith({
      userId: user.id,
      conversationId: conv.id,
      messageId: reply.id,
      runId: reply.id,
      ending: "error",
      reason: "interrupted",
      model: hostModel,
      onHostCredentials: true,
      hidden: false,
    });
  });

  it("fires as stopped for an orphaned Run that stopRun ends, through the chat RPC", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Orphan" });
    const reply = await orphanedReply(conv.id);
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = depsWithRunEnd(onRunEnd);

    await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });

    expect(onRunEnd).toHaveBeenCalledTimes(1);
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ runId: reply.id, ending: "stopped" }),
    );
    expect(onRunEnd.mock.calls[0]?.[0]).not.toHaveProperty("reason");
  });

  it("fires nothing when deleteUser stops an orphaned Run", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Host delete" });
    await orphanedReply(conv.id);
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();

    await deleteUserData(depsWithRunEnd(onRunEnd), user.id);

    expect((await getTestDb().select().from(conversation)).some((row) => row.id === conv.id)).toBe(
      false,
    );
    expect(onRunEnd).not.toHaveBeenCalled();
  });

  it("fires an orphaned Run's stop when the user deletes all their Conversations, after the commit", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Deleted all" });
    const reply = await orphanedReply(conv.id);
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();

    await deleteAllConversations(depsWithRunEnd(onRunEnd), user.id);

    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ runId: reply.id, ending: "stopped" }),
    );
  });

  it("fires nothing for an orphaned Run whose delete of all Conversations rolls back", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Rolled back" });
    const reply = await orphanedReply(conv.id);
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = depsWithRunEnd(onRunEnd, {
      db: failingDeleteOf(getTestDb(), conversation),
    });

    await expect(deleteAllConversations(deps, user.id)).rejects.toThrow("delete failed");

    expect(onRunEnd).not.toHaveBeenCalled();
    expect((await replyOf(conv.id)).id).toBe(reply.id);
    expect((await replyOf(conv.id)).status).toBe("streaming");
  });

  it("fires an orphaned Run's stop when its Project is deleted, after the commit", async () => {
    const user = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Thesis" });
    const conv = await insertConversation(user, { title: "In project", projectId });
    const reply = await orphanedReply(conv.id);
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = depsWithRunEnd(onRunEnd);

    await chatRpc({ user, deps }).project.delete({ id: projectId });

    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ runId: reply.id, ending: "stopped" }),
    );
  });

  it("fires once when a Stop ends a Run whose owner is still alive but late with its heartbeat", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Late owner" });
    const held = createFakeAdapter({ rounds: [round(text("Hi"))], manual: true });
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = depsWithRunEnd(onRunEnd, { adapterFor: () => held.adapter });

    const response = await sendAs(runRequest(conv.id), user, deps);
    const reply = await replyOf(conv.id);
    // The owner is alive, but its heartbeat has lapsed: the Stop ends the Run as an orphan.
    await getTestDb()
      .update(message)
      .set({ heartbeatAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(message.id, reply.id));
    await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });
    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    // The owner wakes and tries to save its own ending; the Message has ended, so nothing fires.
    await held.releaseAll();
    await response.text();
    await vi.waitFor(() => expect(deps.lifecycle.runs.size).toBe(0));

    expect(onRunEnd).toHaveBeenCalledTimes(1);
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ runId: reply.id, ending: "stopped" }),
    );
  });

  it("fires nothing for a live Run whose user is deleted: its owner's write matches no row", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Live delete" });
    const held = createFakeAdapter({ rounds: [round(text("Hi"))], manual: true });
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = depsWithRunEnd(onRunEnd, { adapterFor: () => held.adapter });

    const response = await sendAs(runRequest(conv.id), user, deps);
    // The heartbeat is fresh, so the delete leaves the Run to its owner, which ends it after the commit.
    await deleteUserData(deps, user.id);
    await vi.waitFor(() => expect(deps.lifecycle.runs.size).toBe(0));
    await response.text();

    expect(onRunEnd).not.toHaveBeenCalled();
  });
});

describe("the SDK's failures", () => {
  it("sends a failed usage write to the Host's logger, and the Run still completes", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Write fails" });
    const error = vi.fn();
    // Only the usage insert fails; the Run's own writes go through.
    const db = getTestDb();
    const failingUsageDb = new Proxy(db, {
      get: (target, key) => {
        if (key !== "insert") return Reflect.get(target, key, target);
        return (table: unknown) =>
          table === usage
            ? { values: () => Promise.reject(new Error("usage write failed")) }
            : target.insert(table as never);
      },
    });
    const deps = createTestDeps({
      db: failingUsageDb,
      adapterFor: () => createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter,
      hostProviders: [hostProvider],
      logger: { error },
    });
    const handler = createChatHandler(deps, {
      basePath,
      getUser: () => ({ id: user.id }),
      logger: { error },
    });

    await runOnce(handler, conv.id);

    expect(await replyStatus(conv.id)).toBe("complete");
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/Recording usage of/),
      expect.anything(),
    );
  });

  it("sends a failed title generation to the Host's logger", async () => {
    const user = await insertUser();
    // Untitled, so the complete Run asks the Model for a title, which the one-round script can't give.
    const conv = await insertConversation(user, { title: null });
    const error = vi.fn();
    // One shared adapter: the Run uses its only round, so the title call finds none.
    const fake = createFakeAdapter({ rounds: [round(text("Hello"))] });
    const deps = createTestDeps({
      adapterFor: () => fake.adapter,
      hostProviders: [hostProvider],
      logger: { error },
    });
    const handler = createChatHandler(deps, {
      basePath,
      getUser: () => ({ id: user.id }),
      logger: { error },
    });

    await runOnce(handler, conv.id);

    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/Generating a title with/),
      expect.anything(),
    );
  });
});
