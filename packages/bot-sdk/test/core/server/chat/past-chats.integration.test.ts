import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { conversation, message, project, userSettings } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { loadSharedConversation } from "../../../../core/server/share/store";
import type { ChatCommand } from "../../../../core/shared/chat/command";
import { storedParts } from "../../../../core/shared/message-parts";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser, type TestUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

const searchCall = (id: string, query: string) =>
  toolCall({ id, name: "search_past_chats", input: { query } });

/** A user with an Anthropic key and a scripted reply adapter. */
async function setup(rounds: Rounds, overrides: TestDepsOverrides = {}) {
  const user = await insertUser();
  const fake = createFakeAdapter({ rounds });
  const deps = createTestSdk({ adapterFor: () => fake.adapter, ...overrides });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  return { user, deps, fake };
}

/** Sends one Message in `conversationId` and drains its Run. */
async function sendIn(
  deps: TestDeps,
  user: TestUser,
  conversationId: string,
  command: Partial<ChatCommand> = {},
) {
  const response = await sendAs(
    new Request("http://localhost/api/chat/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        forwardedProps: {
          conversationId,
          parentId: null,
          text: "What did we decide?",
          attachmentIds: [],
          model: anthropicModel,
          ...command,
        },
      }),
    }),
    user,
    deps,
  );
  await response.text();
}

/** The assistant reply a Run wrote in a Conversation. */
async function replyOf(deps: TestDeps, conversationId: string) {
  const rows = await deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.find((row) => row.role === "assistant")!;
}

/** The stored `past_chats_search` part of a reply, if it has one. */
function searchOf(reply: Awaited<ReturnType<typeof replyOf>>) {
  return reply.parts.parts.find((part) => part.type === "past_chats_search");
}

const conversationIdsOf = (reply: Awaited<ReturnType<typeof replyOf>>) =>
  searchOf(reply)?.type === "past_chats_search"
    ? searchOf(reply)!.conversations.map((found) => found.conversationId)
    : [];

const offeredTools = (fake: ReturnType<typeof createFakeAdapter>) =>
  (fake.calls[0]?.tools ?? []).map((tool) => tool.name);

/** A Conversation whose Messages alternate user and assistant, the last one active. */
async function chatWith(
  user: TestUser,
  texts: string[],
  fields: Partial<typeof conversation.$inferInsert> = {},
) {
  const conv = await insertConversation(user, { title: "Earlier chat", ...fields });
  let parentId: string | null = null;
  for (const [index, body] of texts.entries()) {
    const row = await insertMessage({
      conversationId: conv.id,
      parentId,
      role: index % 2 === 0 ? "user" : "assistant",
      text: body,
      active: index === texts.length - 1,
    });
    parentId = row.id;
  }
  return conv;
}

describe("the search_past_chats tool", () => {
  it("finds earlier Conversations by keywords that aren't side by side", async () => {
    const { user, deps } = await setup([
      round(text("Checking."), searchCall("call-1", "drizzle tooling")),
      round(text("You chose Drizzle.")),
    ]);
    const older = await chatWith(
      user,
      ["We agreed the big decision: Drizzle for the migration tooling.", "Sounds good."],
      { title: "Migration" },
    );
    await chatWith(user, ["My cat is sleepy today."], { title: "Cats" });
    const current = await insertConversation(user, { title: "Now" });

    await sendIn(deps, user, current.id);

    const reply = await replyOf(deps, current.id);
    expect(reply.parts).toMatchObject(
      storedParts([
        { type: "text", text: "Checking." },
        {
          type: "past_chats_search",
          toolCallId: "call-1",
          query: "drizzle tooling",
          state: "done",
          conversations: [
            {
              conversationId: older.id,
              title: "Migration",
              date: expect.any(String),
              snippets: [expect.stringContaining("Drizzle")],
            },
          ],
        },
        { type: "text", text: "You chose Drizzle." },
      ]),
    );
  });

  it("searches only the Active Branch, and never the current or a Temporary Conversation", async () => {
    const { user, deps } = await setup([
      round(text("Checking."), searchCall("call-1", "orm migration")),
      round(text("Done.")),
    ]);
    // An abandoned answer on a sibling Branch is not found; the Active Branch's answer is.
    const branched = await insertConversation(user, { title: "Branched" });
    const question = await insertMessage({
      conversationId: branched.id,
      role: "user",
      text: "Which ORM?",
    });
    await insertMessage({
      conversationId: branched.id,
      parentId: question.id,
      role: "assistant",
      text: "Prisma is the ORM for this migration.",
    });
    await insertMessage({
      conversationId: branched.id,
      parentId: question.id,
      role: "assistant",
      text: "Drizzle is the ORM for this migration.",
      active: true,
    });
    const temporary = await insertConversation(user, { title: "Private", temporary: true });
    await insertMessage({
      conversationId: temporary.id,
      role: "user",
      text: "Drizzle is the ORM for this migration.",
      active: true,
    });
    // The current Conversation holds the matching words too, but is never searched.
    const current = await insertConversation(user, { title: "Now" });
    const own = await insertMessage({
      conversationId: current.id,
      role: "user",
      text: "Drizzle is the ORM for this migration, noted.",
      active: true,
    });

    await sendIn(deps, user, current.id, { parentId: own.id, text: "Remind me?" });

    const reply = await replyOf(deps, current.id);
    expect(conversationIdsOf(reply)).toEqual([branched.id]);
    expect(searchOf(reply)).toMatchObject({
      conversations: [{ snippets: [expect.stringContaining("Drizzle")] }],
    });
  });

  it("searches a Project's own and the general Conversations, and a general Run only the general ones", async () => {
    const { user, deps } = await setup([
      round(text("Checking."), searchCall("call-1", "drizzle migration")),
      round(text("Done.")),
    ]);
    const projectId = uuidv7();
    const otherProjectId = uuidv7();
    await getTestDb()
      .insert(project)
      .values([
        { id: projectId, userId: user.id, name: "Thesis" },
        { id: otherProjectId, userId: user.id, name: "Client" },
      ]);
    const inProject = await chatWith(user, ["Drizzle migration plan for the thesis."], {
      projectId,
    });
    const general = await chatWith(user, ["Drizzle migration notes, in general."]);
    await chatWith(user, ["Drizzle migration for the client."], { projectId: otherProjectId });
    const currentInProject = await insertConversation(user, { title: "Now", projectId });

    await sendIn(deps, user, currentInProject.id);
    expect(conversationIdsOf(await replyOf(deps, currentInProject.id)).sort()).toEqual(
      [inProject.id, general.id].sort(),
    );

    const generalRun = await setup([
      round(text("Checking."), searchCall("call-2", "drizzle migration")),
      round(text("Done.")),
    ]);
    const generalCurrent = await insertConversation(user, { title: "Now too" });
    await sendIn(generalRun.deps, user, generalCurrent.id);
    expect(conversationIdsOf(await replyOf(generalRun.deps, generalCurrent.id))).toEqual([
      general.id,
    ]);
  });

  it("returns at most 5 Conversations, each with at most 3 snippets of about 300 characters", async () => {
    const { user, deps } = await setup([
      round(text("Checking."), searchCall("call-1", "drizzle")),
      round(text("Done.")),
    ]);
    const long = (word: string) => `${"filler ".repeat(120)}${word} decided here.`;
    for (let index = 0; index < 6; index++) {
      await chatWith(user, [long("drizzle")], { title: `Chat ${index}` });
    }
    // One Conversation with four matching Messages: only three snippets come back.
    await chatWith(user, [long("drizzle"), long("drizzle"), long("drizzle"), long("drizzle")], {
      title: "Many",
    });
    const current = await insertConversation(user, { title: "Now" });

    await sendIn(deps, user, current.id);

    const found = searchOf(await replyOf(deps, current.id));
    expect(found?.type === "past_chats_search" && found.conversations).toHaveLength(5);
    const conversations = found?.type === "past_chats_search" ? found.conversations : [];
    for (const conversation of conversations) {
      expect(conversation.snippets.length).toBeLessThanOrEqual(3);
      for (const snippet of conversation.snippets) {
        expect(snippet.length).toBeLessThanOrEqual(302);
      }
    }
  });

  it("shows only that past chats were searched on a Shared link", async () => {
    const { user, deps } = await setup([
      round(text("Checking."), searchCall("call-1", "migration")),
      round(text("Done.")),
    ]);
    await chatWith(user, ["Our migration plan is secret."], { title: "Secret title" });
    const current = await insertConversation(user, { title: "Now" });
    await sendIn(deps, user, current.id);
    const link = await chatRpc({ user, deps }).share.upsert({ conversationId: current.id });

    const shared = await loadSharedConversation(deps, link.token);

    const json = JSON.stringify(shared);
    expect(json).not.toContain("Secret title");
    expect(json).not.toContain("Our migration plan");
    const searched = shared?.messages
      .at(-1)
      ?.parts.find((part) => part.type === "tool-call" && part.name === "search_past_chats");
    expect(searched).toMatchObject({ metadata: { redacted: true } });
  });

  it("isn't offered with Memory off for the Host, off for the user, or in a Temporary Conversation", async () => {
    const hostOff = await setup([round(text("Done."))], { memory: false });
    await sendIn(hostOff.deps, hostOff.user, (await insertConversation(hostOff.user, {})).id);
    expect(offeredTools(hostOff.fake)).not.toContain("search_past_chats");

    const userOff = await setup([round(text("Done."))]);
    await getTestDb()
      .insert(userSettings)
      .values({ userId: userOff.user.id, memoryEnabled: false });
    await sendIn(userOff.deps, userOff.user, (await insertConversation(userOff.user, {})).id);
    expect(offeredTools(userOff.fake)).not.toContain("search_past_chats");

    const temporary = await setup([round(text("Done."))]);
    const temporaryConv = await insertConversation(temporary.user, { temporary: true });
    await sendIn(temporary.deps, temporary.user, temporaryConv.id);
    expect(offeredTools(temporary.fake)).not.toContain("search_past_chats");

    const on = await setup([round(text("Done."))]);
    await sendIn(on.deps, on.user, (await insertConversation(on.user, {})).id);
    expect(offeredTools(on.fake)).toContain("search_past_chats");
  });
});
