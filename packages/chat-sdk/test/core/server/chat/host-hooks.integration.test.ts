import { and, asc, eq } from "drizzle-orm";
import { type AnyTextAdapter, toolDefinition } from "@tanstack/ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createChatClient } from "../../../../core/client/chat-client";
import type { HostToolContext } from "../../../../core/server/chat/host-tools";
import {
  createHookEmitter,
  type ConversationCreatedEvent,
  type ConversationDeletedEvent,
  type ModerationInput,
  type ModerationOutput,
  type ModerationResult,
  type RunEndEvent,
  type SharedLinkChangedEvent,
} from "../../../../core/server/chat/hooks";
import { reapStaleRuns } from "../../../../core/server/chat/run";
import {
  createChat,
  createChatHandler,
  type CreateChatOptions,
} from "../../../../core/server/create-chat";
import { deleteAllConversations, deleteUserData } from "../../../../core/server/delete-user";
import { deleteProject } from "../../../../core/server/project/store";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { conversation, message, project } from "../../../../core/server/db/schema/chat";
import { usage } from "../../../../core/server/db/schema/usage";
import type { HostProvider } from "../../../../core/server/deps";
import { createLifecycle } from "../../../../core/server/lifecycle";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { createTestDeps, testKeyEncryptionSecret } from "../../../support/deps";
import { insertAttachment } from "../../../support/attachments";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createFakeAdapter, round, runError, text, toolCall } from "../../../support/fake-adapter";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb, testDatabaseUrl } from "../../../support/test-database";
import { insertUser, type TestUser } from "../../../support/users";

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

/** A delete that fails when awaited, bare or with `.returning()`. */
function failingDelete() {
  const fail = () => Promise.reject(new Error("delete failed"));
  const failed = fail();
  failed.catch(() => {});
  return Object.assign(failed, { returning: fail });
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
                    ? { where: () => failingDelete() }
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

  it("records one usage row when a Stop ends a Host Run whose owner is still alive but late", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Late owner usage" });
    const held = createFakeAdapter({ rounds: [round(text("Hi"))], manual: true });
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = depsWithRunEnd(onRunEnd, { adapterFor: () => held.adapter });

    const response = await sendAs(runRequest(conv.id), user, deps);
    const reply = await replyOf(conv.id);
    await getTestDb()
      .update(message)
      .set({ heartbeatAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(message.id, reply.id));
    await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });
    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    // The owner's ending matches no row, yet its Run was on Host credentials and spent tokens.
    await held.releaseAll();
    await response.text();
    await vi.waitFor(() => expect(deps.lifecycle.runs.size).toBe(0));

    const rows = await getTestDb().select().from(usage).where(eq(usage.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "run", model: hostModel });
    expect(onRunEnd).toHaveBeenCalledTimes(1);
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
/** The typed RPC client of a `createChat`'s handler, for the Conversation and Shared link procedures. */
function rpcOf(chat: ReturnType<typeof createChat>) {
  return createChatClient({ baseUrl: `http://localhost${basePath}`, fetch: chat.handler }).rpc;
}

/** A Conversation whose Active Branch ends in a complete reply: ready to share. */
async function answeredConversation(
  user: TestUser,
  fields: Partial<typeof conversation.$inferInsert> = {},
) {
  const conv = await insertConversation(user, { title: "Shared", ...fields });
  const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Question" });
  await insertMessage({
    conversationId: conv.id,
    parentId: question.id,
    role: "assistant",
    text: "Answer",
    active: true,
  });
  return conv;
}

describe("the Conversation and Shared link hooks", () => {
  /** A `createChat` for `userId` whose three hooks are recording mocks. */
  function recordingChat(userId: string) {
    const hooks = {
      onConversationCreated: vi.fn<(event: ConversationCreatedEvent) => unknown>(),
      onConversationDeleted: vi.fn<(event: ConversationDeletedEvent) => unknown>(),
      onSharedLinkChanged: vi.fn<(event: SharedLinkChangedEvent) => unknown>(),
    };
    return { hooks, rpc: rpcOf(chatWith({ userId, hooks })) };
  }

  it("fires onConversationCreated once when a user starts a Conversation", async () => {
    const user = await insertUser();
    const { hooks, rpc } = recordingChat(user.id);

    const { id } = await rpc.conversation.create({ model: hostModel });

    await vi.waitFor(() => expect(hooks.onConversationCreated).toHaveBeenCalledTimes(1));
    expect(hooks.onConversationCreated).toHaveBeenCalledWith({
      userId: user.id,
      conversationId: id,
      fromSharedLink: false,
    });
  });

  it("includes the Project when a Conversation starts in one", async () => {
    const user = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Thesis" });
    const { hooks, rpc } = recordingChat(user.id);

    const { id } = await rpc.conversation.create({ model: hostModel, projectId });

    await vi.waitFor(() => expect(hooks.onConversationCreated).toHaveBeenCalledTimes(1));
    expect(hooks.onConversationCreated).toHaveBeenCalledWith({
      userId: user.id,
      conversationId: id,
      projectId,
      fromSharedLink: false,
    });
  });

  it("fires onConversationCreated with fromSharedLink when a Shared link is continued", async () => {
    const user = await insertUser();
    const conv = await answeredConversation(user);
    const { hooks, rpc } = recordingChat(user.id);
    const link = await rpc.share.upsert({ conversationId: conv.id });

    const copy = await rpc.share.continue({ token: link.token });

    await vi.waitFor(() => expect(hooks.onConversationCreated).toHaveBeenCalledTimes(1));
    expect(hooks.onConversationCreated).toHaveBeenCalledWith({
      userId: user.id,
      conversationId: copy.id,
      fromSharedLink: true,
    });
  });

  it("fires onConversationDeleted once when a user deletes a Conversation", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Gone" });
    const { hooks, rpc } = recordingChat(user.id);

    await rpc.conversation.delete({ id: conv.id });

    await vi.waitFor(() => expect(hooks.onConversationDeleted).toHaveBeenCalledTimes(1));
    expect(hooks.onConversationDeleted).toHaveBeenCalledWith({
      userId: user.id,
      conversationId: conv.id,
    });
  });

  it("fires onConversationDeleted once per Conversation when a Project with three is deleted", async () => {
    const user = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Thesis" });
    const conversations = await Promise.all(
      [1, 2, 3].map(() => insertConversation(user, { projectId })),
    );
    const { hooks, rpc } = recordingChat(user.id);

    await rpc.project.delete({ id: projectId });

    await vi.waitFor(() => expect(hooks.onConversationDeleted).toHaveBeenCalledTimes(3));
    for (const conv of conversations) {
      expect(hooks.onConversationDeleted).toHaveBeenCalledWith({
        userId: user.id,
        conversationId: conv.id,
        projectId,
      });
    }
  });

  it("fires onConversationDeleted for each Conversation a user deletes all of", async () => {
    const user = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Thesis" });
    const inProject = await insertConversation(user, { projectId });
    const loose = await insertConversation(user);
    const { hooks, rpc } = recordingChat(user.id);

    await rpc.conversation.deleteAll();

    await vi.waitFor(() => expect(hooks.onConversationDeleted).toHaveBeenCalledTimes(2));
    expect(hooks.onConversationDeleted).toHaveBeenCalledWith({
      userId: user.id,
      conversationId: inProject.id,
      projectId,
    });
    expect(hooks.onConversationDeleted).toHaveBeenCalledWith({
      userId: user.id,
      conversationId: loose.id,
    });
  });

  it("fires no Conversation or Shared link event when the Host deletes the user", async () => {
    const user = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Thesis" });
    const conv = await answeredConversation(user, { projectId });
    const hooks = {
      onConversationCreated: vi.fn<(event: ConversationCreatedEvent) => unknown>(),
      onConversationDeleted: vi.fn<(event: ConversationDeletedEvent) => unknown>(),
      onSharedLinkChanged: vi.fn<(event: SharedLinkChangedEvent) => unknown>(),
    };
    await rpcOf(chatWith({ userId: user.id, hooks })).share.upsert({ conversationId: conv.id });
    hooks.onSharedLinkChanged.mockClear();
    const deps = createTestDeps({
      hostProviders: [hostProvider],
      hooks: createHookEmitter(hooks, { error: () => {} }),
    });

    await deleteUserData(deps, user.id);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(hooks.onConversationCreated).not.toHaveBeenCalled();
    expect(hooks.onConversationDeleted).not.toHaveBeenCalled();
    expect(hooks.onSharedLinkChanged).not.toHaveBeenCalled();
  });

  it("fires onSharedLinkChanged created, moved and removed for sharing, sharing again and unsharing", async () => {
    const user = await insertUser();
    const conv = await answeredConversation(user);
    const { hooks, rpc } = recordingChat(user.id);

    await rpc.share.upsert({ conversationId: conv.id });
    await rpc.share.upsert({ conversationId: conv.id });
    await rpc.share.delete({ conversationId: conv.id });

    await vi.waitFor(() => expect(hooks.onSharedLinkChanged).toHaveBeenCalledTimes(3));
    expect(hooks.onSharedLinkChanged.mock.calls.map(([event]) => event)).toEqual([
      { userId: user.id, conversationId: conv.id, change: "created" },
      { userId: user.id, conversationId: conv.id, change: "moved" },
      { userId: user.id, conversationId: conv.id, change: "removed" },
    ]);
  });

  it("fires nothing when a user unshares a Conversation that has no Shared link", async () => {
    const user = await insertUser();
    const conv = await answeredConversation(user);
    const { hooks, rpc } = recordingChat(user.id);

    await rpc.share.delete({ conversationId: conv.id });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(hooks.onSharedLinkChanged).not.toHaveBeenCalled();
  });

  it("fires nothing for a Project delete that rolls back", async () => {
    const user = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Thesis" });
    await insertConversation(user, { projectId });
    const onConversationDeleted = vi.fn<(event: ConversationDeletedEvent) => unknown>();
    const deps = createTestDeps({
      db: failingDeleteOf(getTestDb(), project),
      hooks: createHookEmitter({ onConversationDeleted }, { error: () => {} }),
    });

    await expect(deleteProject(deps, user.id, projectId)).rejects.toThrow("delete failed");

    expect(onConversationDeleted).not.toHaveBeenCalled();
  });
});

/** Posts one Run for `conversationId` to the handler, as the composer does, and returns the response. */
function postRun(
  handler: ReturnType<typeof createChat>["handler"],
  conversationId: string,
  command: { text?: string; attachmentIds?: string[]; model?: string } = {},
) {
  return handler(
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
          model: hostModel,
          webSearch: false,
          ...command,
        },
      }),
    }),
  );
}

describe("the moderate hook on the user's Message", () => {
  it("refuses a Message the Host disallows with 422 moderated and the reason, and saves nothing", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Refused" });
    const fake = createFakeAdapter({ rounds: [round(text("Hello"))] });
    scripted.adapter = fake.adapter;
    const chat = chatWith({
      userId: user.id,
      hooks: { moderate: () => ({ allow: false, reason: "Off-policy request" }) },
    });

    const response = await postRun(chat.handler, conv.id, { text: "Something disallowed" });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      message: "Off-policy request",
      code: "moderated",
      reason: "Off-policy request",
    });
    const messages = await getTestDb()
      .select()
      .from(message)
      .where(eq(message.conversationId, conv.id));
    expect(messages).toHaveLength(0);
    expect(await getTestDb().select().from(usage).where(eq(usage.userId, user.id))).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("answers a refusal without a reason with a default message", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Refused without reason" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const chat = chatWith({ userId: user.id, hooks: { moderate: () => ({ allow: false }) } });

    const response = await postRun(chat.handler, conv.id);
    const body = (await response.json()) as { message: string; code: string; reason?: string };

    expect(response.status).toBe(422);
    expect(body.code).toBe("moderated");
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.reason).toBeUndefined();
  });

  it("hands the hook the text and the image and text Attachments, with readable bytes", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Attachments" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const notes = await insertAttachment(user, {
      filename: "notes.txt",
      mediaType: "text/plain",
      contents: "Some notes",
    });
    const cat = await insertAttachment(user, {
      filename: "cat.png",
      mediaType: "image/png",
      contents: "png-bytes",
    });
    const doc = await insertAttachment(user, {
      filename: "doc.pdf",
      mediaType: "application/pdf",
      contents: "pdf-bytes",
    });
    const seen: unknown[] = [];
    const chat = chatWith({
      userId: user.id,
      hooks: {
        moderate: async (check) => {
          if (check.phase !== "input") return { allow: true };
          const attachments = await Promise.all(
            check.attachments.map(async (file) => ({
              name: file.name,
              mediaType: file.mediaType,
              bytes: Buffer.from(await file.read()).toString(),
            })),
          );
          seen.push({ text: check.text, onHostCredentials: check.onHostCredentials, attachments });
          return { allow: true };
        },
      },
    });

    const response = await postRun(chat.handler, conv.id, {
      text: "Read these",
      attachmentIds: [notes.id, cat.id, doc.id],
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    const [input] = seen as { attachments: { name: string }[] }[];
    expect(input).toEqual({
      text: "Read these",
      onHostCredentials: true,
      attachments: expect.any(Array),
    });
    expect(
      (input!.attachments as { name: string; bytes: string }[])
        .map(({ name, bytes }) => [name, bytes])
        .sort(),
    ).toEqual([
      ["cat.png", "png-bytes"],
      ["notes.txt", "Some notes"],
    ]);
  });

  it("lets an allowed Message proceed as it does without the hook", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Allowed" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const moderate = vi.fn<(check: ModerationInput | ModerationOutput) => ModerationResult>(() => ({
      allow: true,
    }));
    const chat = chatWith({ userId: user.id, hooks: { moderate } });

    const response = await postRun(chat.handler, conv.id, { text: "Fine" });
    await response.text();

    expect(response.status).toBe(200);
    // The reply is checked too when it ends (#268); this test is about the Message's input check.
    expect(moderate.mock.calls.filter(([check]) => check.phase === "input")).toHaveLength(1);
    expect(await replyStatus(conv.id)).toBe("complete");
  });

  it("tells the hook a Run on the user's own credentials is not on Host credentials", async () => {
    const user = await insertUser();
    const deps = createTestDeps();
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });
    const conv = await insertConversation(user, { title: "Own key moderated" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const moderate = vi.fn(() => ({ allow: true as const }));
    const chat = chatWith({ userId: user.id, hostProviders: [], hooks: { moderate } });

    const response = await postRun(chat.handler, conv.id, { text: "Hi" });
    await response.text();

    expect(moderate).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "input", onHostCredentials: false }),
    );
  });

  it("lets the Message through and logs when the hook throws", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Throws" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const error = vi.fn();
    const chat = chatWith({
      userId: user.id,
      logger: { error },
      hooks: {
        moderate: () => {
          throw new Error("vendor down");
        },
      },
    });

    const response = await postRun(chat.handler, conv.id, { text: "Fine" });
    await response.text();

    expect(response.status).toBe(200);
    expect(await replyStatus(conv.id)).toBe("complete");
    expect(error).toHaveBeenCalledWith(expect.any(String), new Error("vendor down"));
  });

  it("lets the Message through and logs when the hook takes longer than 10 seconds", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "Slow" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const error = vi.fn();
    const moderate = vi.fn(() => new Promise<never>(() => {}));
    const chat = chatWith({ userId: user.id, logger: { error }, hooks: { moderate } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = postRun(chat.handler, conv.id, { text: "Fine" });
      await vi.waitFor(() => expect(moderate).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(10_000);
      const response = await pending;

      expect(response.status).toBe(200);
      expect(error).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls nothing and refuses nothing when the Host has no moderate hook", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { title: "No hook" });
    scripted.adapter = createFakeAdapter({ rounds: [round(text("Hello"))] }).adapter;
    const chat = chatWith({ userId: user.id, hooks: {} });

    const response = await postRun(chat.handler, conv.id, { text: "Fine" });
    await response.text();

    expect(response.status).toBe(200);
    expect(await replyStatus(conv.id)).toBe("complete");
  });
});
