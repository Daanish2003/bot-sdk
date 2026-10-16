import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import { moveConversation, deleteConversation } from "../../../../core/server/chat/store";
import { project, memory } from "../../../../core/server/db/schema";
import { deleteUserData } from "../../../../core/server/delete-user";
import { deleteProject } from "../../../../core/server/project/store";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { insertMemory } from "../../../support/memories";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

async function memoryIds(userId: string) {
  const rows = await getTestDb()
    .select({ id: memory.id })
    .from(memory)
    .where(eq(memory.userId, userId));
  return rows.map((row) => row.id).sort();
}

describe("deleting a Conversation takes its Memories", () => {
  it("deletes the Memories made in it and leaves the other Conversations' alone", async () => {
    const owner = await insertUser();
    const gone = await insertConversation(owner, { title: "Gone" });
    const kept = await insertConversation(owner, { title: "Kept" });
    await insertMemory(owner, { conversationId: gone.id });
    const keptMemory = await insertMemory(owner, { conversationId: kept.id });

    expect(await deleteConversation(createTestDeps(), owner.id, gone.id)).toBe(true);

    expect(await memoryIds(owner.id)).toEqual([keptMemory.id]);
  });

  it("keeps an outdated Memory that a deleted Memory replaced, outdated and unlinked", async () => {
    const owner = await insertUser();
    const older = await insertConversation(owner, { title: "Older" });
    const newer = await insertConversation(owner, { title: "Newer" });
    const outdated = await insertMemory(owner, {
      conversationId: older.id,
      text: "Runs 5k in 25 minutes",
      invalidAt: new Date("2026-10-02T10:00:00Z"),
    });
    const replacing = await insertMemory(owner, {
      conversationId: newer.id,
      text: "Runs 5k in 22 minutes",
    });
    await getTestDb()
      .update(memory)
      .set({ replacedById: replacing.id })
      .where(eq(memory.id, outdated.id));

    await deleteConversation(createTestDeps(), owner.id, newer.id);

    const [row] = await getTestDb().select().from(memory).where(eq(memory.id, outdated.id));
    expect(row).toMatchObject({
      invalidAt: new Date("2026-10-02T10:00:00Z"),
      replacedById: null,
    });
  });
});

describe("deleting a Project takes the Memories of its Conversations", () => {
  it("deletes the Memories made in the Project and keeps the general ones", async () => {
    const owner = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: owner.id, name: "Work" });
    const inProject = await insertConversation(owner, { title: "In", projectId });
    const general = await insertConversation(owner, { title: "General" });
    await insertMemory(owner, { conversationId: inProject.id });
    const generalMemory = await insertMemory(owner, { conversationId: general.id });

    await deleteProject(createTestDeps(), owner.id, projectId);

    expect(await memoryIds(owner.id)).toEqual([generalMemory.id]);
  });
});

describe("moving a Conversation moves its Memories", () => {
  it("shows them under the Project and then under General on the Memory page, and recalls them only in that scope", async () => {
    const owner = await insertUser();
    const replyFake = createFakeAdapter({
      rounds: [round(text("Noted.")), round(text("Noted.")), round(text("Noted."))],
    });
    const deps = createTestDeps({
      clock: () => new Date("2026-10-14T10:00:00Z"),
      adapterFor: () => replyFake.adapter,
    });
    await saveCredentials(deps, owner.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-test-key" },
      hint: "…-key",
      verified: true,
    });
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: owner.id, name: "Thesis" });
    const moving = await insertConversation(owner, { title: "Moving" });
    const other = await insertConversation(owner, { title: "Other" });
    await insertMemory(owner, { conversationId: moving.id, text: "Advisor is Dr. Rao" });
    const rpc = chatRpc({ user: owner, deps });
    const send = async (conversationId: string) =>
      (
        await sendAs(
          new Request("http://localhost/api/chat/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [],
              forwardedProps: {
                conversationId,
                parentId: null,
                text: "Where is my draft?",
                attachmentIds: [],
                model: "anthropic:claude-sonnet-5-5",
                webSearch: false,
              },
            }),
          }),
          owner,
          deps,
        )
      ).text();
    /** The Memories block of the last Run, or `""` when it sent none. */
    const lastBlock = () =>
      (replyFake.calls.at(-1)?.systemPrompts ?? [])
        .map(String)
        .find((prompt) => prompt.startsWith("Memories")) ?? "";

    await moveConversation(deps, owner.id, moving.id, projectId);
    expect((await rpc.memory.list()).groups.map((group) => group.projectName)).toEqual(["Thesis"]);
    await send(moving.id);
    expect(lastBlock()).toContain("Advisor is Dr. Rao");
    await send(other.id);
    expect(lastBlock()).toBe("");

    await moveConversation(deps, owner.id, moving.id, null);
    expect((await rpc.memory.list()).groups.map((group) => group.projectName)).toEqual([null]);
    await send(other.id);
    expect(lastBlock()).toContain("Advisor is Dr. Rao");
  });
});

describe("deleting an account takes every Memory", () => {
  it("deletes all of the user's Memories and leaves other users' alone", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const ownerConv = await insertConversation(owner, { title: "Mine" });
    const otherConv = await insertConversation(other, { title: "Theirs" });
    await insertMemory(owner, { conversationId: ownerConv.id });
    await insertMemory(owner, { conversationId: ownerConv.id, invalidAt: new Date() });
    const theirs = await insertMemory(other, { conversationId: otherConv.id });

    await deleteUserData(createTestDeps(), owner.id);

    expect(await memoryIds(owner.id)).toEqual([]);
    expect(await memoryIds(other.id)).toEqual([theirs.id]);
  });
});
