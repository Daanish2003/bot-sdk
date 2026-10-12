import { asc, eq } from "drizzle-orm";
import type { AnyTextAdapter } from "@tanstack/ai";
import { describe, expect, it, vi } from "vitest";

import {
  createChat,
  createChatHandler,
  type CreateChatOptions,
} from "../../../../core/server/create-chat";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { message } from "../../../../core/server/db/schema/chat";
import { usage } from "../../../../core/server/db/schema/usage";
import type { HostProvider } from "../../../../core/server/deps";
import { createTestDeps, testKeyEncryptionSecret } from "../../../support/deps";
import { insertConversation } from "../../../support/conversations";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
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
