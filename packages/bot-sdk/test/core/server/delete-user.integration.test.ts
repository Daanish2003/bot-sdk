import { randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { deleteUserData } from "../../../core/server/user-data";
import { bot as botPlugin } from "../../../plugins/bot/server/plugin";
import { models } from "../../../plugins/models/server/plugin";
import { saveCredentials } from "../../../plugins/models/server/credentials/store";
import {
  bot,
  botTurn,
  conversation,
  message,
  userCredentials,
  usage,
} from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { botOf, botSdk, sendToTurnEnd, stopBotRunners } from "../../support/bot-turns";
import type { TestDeps } from "../../support/deps";
import { createFakeAdapter, round, toolCall, withUsage } from "../../support/fake-adapter";
import { followSend } from "../../support/follow-send";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser, type TestUser } from "../../support/users";

const testKey = "test-key-encryption-secret-not-for-production";
const sonnet = "anthropic:claude-sonnet-5-5";

/** A Step that sends "Hello" and ends the Turn, reporting some usage. */
const hello = () =>
  withUsage(round(toolCall({ name: "send_to_user", input: { text: "Hello", endTurn: true } })), {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });

afterEach(stopBotRunners);

/** A user with their own key and a Bot that has run a Turn: a Conversation, Messages and usage. */
async function seedOwner(user: TestUser, deps: TestDeps) {
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  const { client, botId } = await botOf(deps, user, sonnet);
  await sendToTurnEnd(client, botId);
  return { client, botId };
}

/** Every row the SDK holds for the user in the tables a Turn writes, by table. */
async function ownedRows(userId: string) {
  const db = getTestDb();
  const ownConversations = db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.userId, userId));
  const ownBots = db.select({ id: bot.id }).from(bot).where(eq(bot.userId, userId));
  const count = async (query: Promise<unknown[]>) => (await query).length;
  return {
    conversations: await count(
      db.select().from(conversation).where(eq(conversation.userId, userId)),
    ),
    messages: await count(
      db.select().from(message).where(inArray(message.conversationId, ownConversations)),
    ),
    bots: await count(db.select().from(bot).where(eq(bot.userId, userId))),
    turns: await count(db.select().from(botTurn).where(inArray(botTurn.botId, ownBots))),
    credentials: await count(
      db.select().from(userCredentials).where(eq(userCredentials.userId, userId)),
    ),
    usage: await count(db.select().from(usage).where(eq(usage.userId, userId))),
  };
}

const emptyRows = { conversations: 0, messages: 0, bots: 0, turns: 0, credentials: 0, usage: 0 };

/** A test SDK whose Bots' Turns each send "Hello". */
async function helloSdk() {
  const fake = createFakeAdapter({ rounds: Array.from({ length: 4 }, hello) });
  return (await botSdk({ adapterFor: () => fake.adapter })).deps;
}

describe("deleteUserData, with Bots", () => {
  it("removes the user's Bots, Turns, Messages, credentials and usage, and leaves other users' rows alone", async () => {
    const deps = await helloSdk();
    const owner = await insertUser();
    const other = await insertUser();
    await seedOwner(owner, deps);
    const kept = await seedOwner(other, deps);
    const before = await ownedRows(other.id);
    expect(Object.values(before).every((total) => total > 0)).toBe(true);

    await deleteUserData(deps, owner.id);

    expect(await ownedRows(owner.id)).toEqual(emptyRows);
    expect(await ownedRows(other.id)).toEqual(before);
    expect(await kept.client.bot.list()).toHaveLength(1);
  });

  it("is idempotent, and an unknown id succeeds", async () => {
    const deps = await helloSdk();
    const owner = await insertUser();
    await seedOwner(owner, deps);

    await deleteUserData(deps, owner.id);
    await deleteUserData(deps, owner.id);
    await deleteUserData(deps, randomUUID());

    expect(await ownedRows(owner.id)).toEqual(emptyRows);
  });

  it("rolls everything back when a step fails mid-way", async () => {
    const deps = await helloSdk();
    const owner = await insertUser();
    await seedOwner(owner, deps);
    const before = await ownedRows(owner.id);
    // The models plugin's step runs after the bot plugin's, and deletes usage last, so a trigger
    // that fails there fails after the user's Bots and credentials are gone.
    await getTestDb().execute(sql`
      create function chat.fail_usage_delete() returns trigger language plpgsql as $$
      begin raise exception 'injected failure'; end $$`);
    await getTestDb().execute(sql`
      create trigger fail_usage_delete before delete on chat.usage
      for each row execute function chat.fail_usage_delete()`);
    try {
      await expect(deleteUserData(deps, owner.id)).rejects.toMatchObject({
        cause: { message: expect.stringContaining("injected failure") },
      });
    } finally {
      await getTestDb().execute(sql`drop function chat.fail_usage_delete() cascade`);
    }

    expect(await ownedRows(owner.id)).toEqual(before);
  });

  it("leaves nothing behind of a Turn that is still running when the user is deleted", async () => {
    // Held until the test releases it, so the Turn is still running when the user is deleted.
    const fake = createFakeAdapter({ rounds: [hello()], manual: true });
    const { deps } = await botSdk({ adapterFor: () => fake.adapter });
    const owner = await insertUser();
    await saveCredentials(deps, owner.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });
    const { client, botId } = await botOf(deps, owner, sonnet);
    await followSend(client, { botId, id: uuidv7(), text: "Hi" });
    await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(0), { timeout: 10_000 });

    await deleteUserData(deps, owner.id);
    await fake.releaseAll();
    await stopBotRunners();

    expect(await ownedRows(owner.id)).toEqual(emptyRows);
  });
});

describe("createBotSdk().deleteUser", () => {
  it("removes the user's rows through the Host's entry point", async () => {
    const deps = await helloSdk();
    const owner = await insertUser();
    const other = await insertUser();
    await seedOwner(owner, deps);
    await seedOwner(other, deps);
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [testKey],
      basePath: "/api/chat",
      plugins: [models(), botPlugin()],
    });

    await chat.deleteUser(owner.id);

    expect(await ownedRows(owner.id)).toEqual(emptyRows);
    expect((await ownedRows(other.id)).bots).toBe(1);
  });
});
