import { afterEach, describe, expect, it } from "vitest";

import { createMemoryPubSub, type PubSub } from "../../../core/server/chat/pubsub";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { saveCredentials } from "../../../plugins/models/server/internal";
import { botSdk, stopBotRunners } from "../../support/bot-turns";
import { createTestSdk } from "../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../support/fake-adapter";
import { followSaved } from "../../support/follow-send";
import { getTestDb } from "../../support/test-database";
import { chatRpc } from "../../support/sdk";
import { insertUser } from "../../support/users";

const model = "openai:gpt-6-luna";

/** A user with an OpenAI key, so `model` is one of their Models, and their HTTP client. */
async function aUser(deps: ReturnType<typeof createTestSdk>) {
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  return { userId: user.id, client: chatRpc({ user, deps }) };
}

describe("sdk.bots, called in-process with a userId (#895)", () => {
  it("creates, lists and gets a Bot as its HTTP twins do", async () => {
    const deps = createTestSdk();
    const { userId, client } = await aUser(deps);

    const created = await deps.bots.create({ userId, name: "  Ada  ", model });

    expect(created).toMatchObject({ name: "Ada", model });
    expect(await deps.bots.list({ userId })).toEqual(await client.bots.list());
    expect(await deps.bots.get({ userId, botId: created.id })).toEqual(
      await client.bots.get({ botId: created.id }),
    );
  }, 30_000);

  it("sends a Message and uploads a file as their HTTP twins do", async () => {
    const deps = createTestSdk();
    const { userId, client } = await aUser(deps);
    const { id: botId } = await deps.bots.create({ userId, name: "Ada", model });
    const file = await deps.bots.upload({ userId, file: new File(["hello"], "note.txt") });
    const id = uuidv7();

    const saved = await deps.bots.send({ userId, botId, id, text: " Hi ", files: [file.id] });

    expect(saved).toMatchObject({ role: "user" });
    // A resend over HTTP with the same id saves nothing new and returns the same Message.
    expect(await client.bots.send({ botId, id, text: "Hi", files: [file.id] })).toEqual(saved);
    expect((await deps.bots.get({ userId, botId })).messages).toEqual([saved]);
    await deps.bots.stop({ userId, botId });
  }, 30_000);

  it("refuses another user's Bot on every method", async () => {
    const deps = createTestSdk();
    const owner = await aUser(deps);
    const { id: botId } = await deps.bots.create({ userId: owner.userId, name: "Ada", model });
    const { userId } = await aUser(deps);
    const messageId = uuidv7();
    const notFound = { code: "NOT_FOUND" };

    await expect(deps.bots.get({ userId, botId })).rejects.toMatchObject(notFound);
    await expect(deps.bots.send({ userId, botId, id: uuidv7(), text: "Hi" })).rejects.toMatchObject(
      notFound,
    );
    await expect(deps.bots.stop({ userId, botId })).rejects.toMatchObject(notFound);
    await expect(deps.bots.warm({ userId, botId })).rejects.toMatchObject(notFound);
    await expect(
      deps.bots.choose({ userId, botId, messageId, answer: { option: "Yes" } }),
    ).rejects.toMatchObject(notFound);
    await expect(deps.bots.react({ userId, botId, messageId, emoji: null })).rejects.toMatchObject(
      notFound,
    );
    expect(await deps.bots.list({ userId })).toEqual([]);
  }, 30_000);
});

describe("sdk.conversations, called in-process with a userId (#895)", () => {
  afterEach(stopBotRunners);

  it("watch yields change hints while a Turn writes, and changes returns those changes, as the conversations.changes RPC does", async () => {
    const replies = createFakeAdapter({
      rounds: [round(toolCall({ name: "send_to_user", input: { text: "Hello", endTurn: true } }))],
    });
    const { deps } = await botSdk({ adapterFor: () => replies.adapter });
    const { userId, client } = await aUser(deps);
    const { id: botId } = await deps.bots.create({ userId, name: "Ada", model });
    const { conversationId, lastSeq } = await deps.bots.get({ userId, botId });
    const stop = new AbortController();
    const hints = await deps.conversations.watch({ userId, conversationId, signal: stop.signal });
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const hint of hints) seen.push(hint);
    })();

    const saved = await deps.bots.send({ userId, botId, id: uuidv7(), text: "Hi" });
    for await (const event of followSaved(getTestDb(), saved)) void event;

    await expect.poll(() => seen.length, { timeout: 10_000 }).toBeGreaterThan(0);
    stop.abort();
    await reading;
    expect(new Set(seen.map((hint) => JSON.stringify(hint)))).toEqual(
      new Set([JSON.stringify({ type: "changed" })]),
    );
    const changes = await deps.conversations.changes({ userId, conversationId, since: lastSeq });
    expect(changes).toEqual(await client.conversations.changes({ conversationId, since: lastSeq }));
    if (changes.reload) throw new Error("changes asked for a reload");
    expect(changes.changes.map((change) => change.kind)).toEqual(
      expect.arrayContaining(["message", "turn"]),
    );
  }, 30_000);

  it("refuses another user's Conversation", async () => {
    const deps = createTestSdk();
    const owner = await aUser(deps);
    const { id: botId } = await deps.bots.create({ userId: owner.userId, name: "Ada", model });
    const { conversationId } = await deps.bots.get({ userId: owner.userId, botId });
    const { userId } = await aUser(deps);

    await expect(deps.conversations.watch({ userId, conversationId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      deps.conversations.changes({ userId, conversationId, since: 0 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 30_000);

  it("ends the subscription when an iteration that never started is returned", async () => {
    const pubsub = createMemoryPubSub();
    let subscribed = 0;
    const counting: PubSub = {
      publish: (channel, message) => pubsub.publish(channel, message),
      subscribe: async (channel, handler) => {
        const unsubscribe = await pubsub.subscribe(channel, handler);
        subscribed += 1;
        return async () => {
          subscribed -= 1;
          await unsubscribe();
        };
      },
    };
    const deps = createTestSdk({ pubsub: counting });
    const { userId } = await aUser(deps);
    const { id: botId } = await deps.bots.create({ userId, name: "Ada", model });
    const { conversationId } = await deps.bots.get({ userId, botId });

    const hints = await deps.conversations.watch({ userId, conversationId });
    expect(subscribed).toBe(1);
    await hints[Symbol.asyncIterator]().return?.();

    expect(subscribed).toBe(0);
  }, 30_000);
});

describe("domain methods' invalid input (#895)", () => {
  it("is refused BAD_REQUEST, as the procedures refuse it", async () => {
    const deps = createTestSdk();
    const { userId, client } = await aUser(deps);
    const badRequest = { code: "BAD_REQUEST", message: "Input validation failed" };

    await expect(deps.bots.create({ userId, name: "  ", model })).rejects.toMatchObject(badRequest);
    await expect(client.bots.create({ name: "  ", model })).rejects.toMatchObject(badRequest);
    await expect(
      deps.conversations.changes({ userId, conversationId: "not-a-uuid", since: 0 }),
    ).rejects.toMatchObject(badRequest);
  }, 30_000);
});
