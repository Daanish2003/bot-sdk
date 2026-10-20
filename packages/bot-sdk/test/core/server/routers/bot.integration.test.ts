import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { bot as botTable, botTurn, conversation } from "../../../../core/server/db/schema";
import { deleteUserData, exportUserData } from "../../../../core/server/user-data";
import { bot } from "../../../../plugins/bot/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { insertMessage } from "../../../support/conversations";
import { createTestSdk } from "../../../support/deps";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser, type TestUser } from "../../../support/users";

const model = "openai:gpt-5.6";

/** A user with an OpenAI key, so `model` is one of their Models, and their client over a Bot-enabled SDK. */
async function signedIn(deps = createTestSdk({ plugins: [bot()] })) {
  const user = await insertUser();
  await withOpenAiKey(user, deps);
  return { user, deps, client: chatRpc({ user, deps }) };
}

async function withOpenAiKey(user: TestUser, deps: ReturnType<typeof createTestSdk>) {
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
}

async function conversationOf(botId: string) {
  const [row] = await getTestDb()
    .select({ conversation })
    .from(botTable)
    .innerJoin(conversation, eq(conversation.id, botTable.conversationId))
    .where(eq(botTable.id, botId));
  return row?.conversation;
}

describe("bot.create", () => {
  it("makes a Bot with an empty Conversation of kind bot and no title", async () => {
    const { user, client } = await signedIn();

    const created = await client.bot.create({ name: "  Inbox Manager  ", model });

    expect(created).toMatchObject({ name: "Inbox Manager", model });
    const botConversation = await conversationOf(created.id);
    expect(botConversation).toMatchObject({
      userId: user.id,
      kind: "bot",
      title: null,
      activeLeafId: null,
    });
    await expect(client.bot.get({ botId: created.id })).resolves.toEqual({
      bot: { ...created, turnStatus: null, userTurnStatus: null },
      conversationId: botConversation!.id,
      messages: [],
      turns: [],
      summaries: [],
      warmings: [],
    });
  });

  it("refuses a Model that isn't available to the user, and saves nothing", async () => {
    const { user, client } = await signedIn();

    await expect(
      client.bot.create({ name: "Ada", model: "anthropic:claude-sonnet-5-5" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const rows = await getTestDb()
      .select()
      .from(conversation)
      .where(eq(conversation.userId, user.id));
    expect(rows).toEqual([]);
  });

  it("refuses a blank name", async () => {
    const { client } = await signedIn();

    await expect(client.bot.create({ name: "   ", model })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("bot.list and bot.get", () => {
  it("lists only the caller's Bots, the newest first", async () => {
    const { client, deps } = await signedIn();
    const first = await client.bot.create({ name: "Ada", model });
    const second = await client.bot.create({ name: "Grace", model });
    const other = await signedIn(deps);
    await other.client.bot.create({ name: "Not mine", model });

    expect((await client.bot.list()).map((row) => row.id)).toEqual([second.id, first.id]);
  });

  it("gives another user not-found for a Bot that isn't theirs", async () => {
    const { client, deps } = await signedIn();
    const created = await client.bot.create({ name: "Ada", model });
    const other = await signedIn(deps);

    await expect(other.client.bot.get({ botId: created.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("keeps Bot Conversations out of the assistant's list", async () => {
    const { client } = await signedIn();
    await client.bot.create({ name: "Ada", model });

    expect((await client.conversation.list({})).items).toEqual([]);
  });
});

describe("the bot plugin's user data", () => {
  it("deletes the user's Bots and their Conversations, and leaves another user's", async () => {
    const { user, client, deps } = await signedIn();
    const created = await client.bot.create({ name: "Ada", model });
    const other = await signedIn(deps);
    const kept = await other.client.bot.create({ name: "Grace", model });

    await deleteUserData(deps, user.id);

    expect(await getTestDb().select().from(botTable).where(eq(botTable.userId, user.id))).toEqual(
      [],
    );
    expect(await conversationOf(created.id)).toBeUndefined();
    expect(
      await getTestDb().select().from(conversation).where(eq(conversation.userId, user.id)),
    ).toEqual([]);
    expect(await conversationOf(kept.id)).toMatchObject({ kind: "bot" });
  });

  it("exports the user's Bots with their Messages", async () => {
    const { user, client, deps } = await signedIn();
    const created = await client.bot.create({ name: "Ada", model });
    const botConversation = await conversationOf(created.id);
    const sent = await insertMessage({
      conversationId: botConversation!.id,
      role: "assistant",
      text: "On it…",
      createdAt: new Date("2026-10-17T09:00:00.000Z"),
    });

    const exported = await exportUserData(deps, user.id);

    expect(exported.bots).toEqual([
      {
        id: created.id,
        name: "Ada",
        model,
        createdAt: created.createdAt,
        messages: [
          {
            id: sent.id,
            role: "assistant",
            text: "On it…",
            createdAt: new Date("2026-10-17T09:00:00.000Z"),
          },
        ],
      },
    ]);
    expect(exported.conversations).toEqual([]);
  });
});

describe("a Bot's status from the server", () => {
  async function say(botId: string, role: "user" | "assistant", text: string, at: string) {
    const created = new Date(at);
    const row = await conversationOf(botId);
    await insertMessage({ conversationId: row!.id, role, text, createdAt: created });
    await getTestDb()
      .update(conversation)
      .set({ lastMessageAt: created })
      .where(eq(conversation.id, row!.id));
    return created;
  }
  /** A Turn row. */
  async function turn(botId: string, status: "running" | "complete" | "error", at: string) {
    await getTestDb()
      .insert(botTurn)
      .values({ id: uuidv7(), botId, status, startedAt: new Date(at) });
  }

  it("lists Bots by newest activity with the last Bot Message and the latest Turn's status", async () => {
    const { client } = await signedIn();
    const quiet = await client.bot.create({ name: "Quiet", model });
    const busy = await client.bot.create({ name: "Busy", model });
    const fresh = await client.bot.create({ name: "Fresh", model });
    await say(quiet.id, "assistant", "first", "2099-10-17T09:00:00Z");
    const sentAt = await say(quiet.id, "assistant", "last words", "2099-10-17T10:00:00Z");
    await say(quiet.id, "user", "ok", "2099-10-17T11:00:00Z");
    await turn(quiet.id, "error", "2099-10-17T09:30:00Z");
    await turn(quiet.id, "complete", "2099-10-17T11:00:01Z");
    await say(busy.id, "user", "hi", "2099-10-17T12:00:00Z");
    await turn(busy.id, "running", "2099-10-17T12:00:01Z");

    const listed = await client.bot.list();

    expect(listed.map((row) => row.id)).toEqual([busy.id, quiet.id, fresh.id]);
    expect(listed.map((row) => row.turnStatus)).toEqual(["running", "complete", null]);
    expect(listed.map((row) => row.lastMessage)).toEqual([
      null,
      { text: "last words", at: sentAt },
      null,
    ]);
  });

  it("gives bot.get the latest Turn's status", async () => {
    const { client } = await signedIn();
    const created = await client.bot.create({ name: "Ada", model });
    await turn(created.id, "complete", "2026-10-17T09:00:00Z");
    await turn(created.id, "running", "2026-10-17T10:00:00Z");

    expect((await client.bot.get({ botId: created.id })).bot.turnStatus).toBe("running");
  });
});
