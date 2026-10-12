import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { conversation, message, project } from "../../../core/server/db/schema/chat";
import { sharedLink } from "../../../core/server/db/schema/share";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { insertConversation, insertMessage } from "../../support/conversations";
import { getTestDb } from "../../support/test-database";
import { insertUser } from "../../support/users";

describe("deleting a Project", () => {
  it("cascades to its Conversations, their Messages and their Shared link", async () => {
    const owner = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: owner.id, name: "Work" });
    const conv = await insertConversation(owner, { title: "In project", projectId });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Hello!",
      active: true,
    });
    await getTestDb()
      .insert(sharedLink)
      .values({
        token: "a".repeat(22),
        conversationId: conv.id,
        leafMessageId: question.id,
        title: "In project",
      });

    await getTestDb().delete(project).where(eq(project.id, projectId));

    expect(await getTestDb().select().from(project).where(eq(project.id, projectId))).toEqual([]);
    expect(
      await getTestDb().select().from(conversation).where(eq(conversation.id, conv.id)),
    ).toEqual([]);
    expect(
      await getTestDb().select().from(message).where(eq(message.conversationId, conv.id)),
    ).toEqual([]);
    expect(
      await getTestDb().select().from(sharedLink).where(eq(sharedLink.conversationId, conv.id)),
    ).toEqual([]);
  });

  it("leaves Conversations outside the Project alone", async () => {
    const owner = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: owner.id, name: "Work" });
    const inProject = await insertConversation(owner, { title: "In", projectId });
    const loose = await insertConversation(owner, { title: "Loose" });

    await getTestDb().delete(project).where(eq(project.id, projectId));

    expect(
      await getTestDb().select().from(conversation).where(eq(conversation.id, inProject.id)),
    ).toEqual([]);
    const remaining = await getTestDb()
      .select()
      .from(conversation)
      .where(eq(conversation.id, loose.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.projectId).toBeNull();
    expect(remaining[0]?.pinnedAt).toBeNull();
  });
});
