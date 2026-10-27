import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { bot as botTable, conversation } from "../src/storage";
import { deleteUserData, exportUserData } from "../src/user-data";
import type { BotExport } from "../src/bot/conversation";
import { saveCredentials } from "../src/models/internal";
import { insertConversation, insertMessage } from "@ai-chat/test-support/conversations";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";

const model = "openai:gpt-6-luna";

/** A user with an OpenAI key and one Bot, and one Conversation of another plugin's holding "otters". */
async function userWithABotAndAnotherConversation() {
  const deps = createTestSdk();
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const ada = await client.bots.create({ name: "Ada", model });
  const other = await insertConversation(user, { kind: "other" });
  await insertMessage({ conversationId: other.id, role: "user", text: "otters", active: true });
  return { deps, user, ada, other };
}

async function kindOf(id: string) {
  const [row] = await getTestDb()
    .select({ kind: conversation.kind })
    .from(conversation)
    .where(eq(conversation.id, id));
  return row?.kind;
}

async function conversationIdOf(botId: string) {
  const [row] = await getTestDb()
    .select({ conversationId: botTable.conversationId })
    .from(botTable)
    .where(eq(botTable.id, botId));
  return row?.conversationId;
}

describe("a Conversation's kind", () => {
  it("is bot for a Bot's Conversation", async () => {
    const { ada } = await userWithABotAndAnotherConversation();

    expect(await kindOf((await conversationIdOf(ada.id))!)).toBe("bot");
  });

  it("keeps another plugin's Conversations out of the bot plugin's export", async () => {
    const { deps, user, ada, other } = await userWithABotAndAnotherConversation();

    const exported = await exportUserData(deps, user.id);

    expect((exported.bot as BotExport).bots.map((row) => row.id)).toEqual([ada.id]);
    expect(JSON.stringify(exported)).not.toContain(other.id);
    expect(JSON.stringify(exported)).not.toContain("otters");
  });

  it("doesn't matter to a user delete, which deletes every Conversation of the user's", async () => {
    const { deps, user, ada, other } = await userWithABotAndAnotherConversation();
    const botConversation = await conversationIdOf(ada.id);

    await deleteUserData(deps, user.id);

    expect(await kindOf(other.id)).toBeUndefined();
    expect(await kindOf(botConversation!)).toBeUndefined();
  });
});
