import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createChat } from "../../../core/server/create-chat";
import { saveCredentials } from "../../../core/server/credentials/store";
import { artifact, artifactVersion } from "../../../core/server/db/schema/artifact";
import { project } from "../../../core/server/db/schema/chat";
import { sharedLink } from "../../../core/server/db/schema/share";
import { userSettings } from "../../../core/server/db/schema/settings";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { insertAttachment, linkTestAttachments } from "../../support/attachments";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestDeps } from "../../support/deps";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser } from "../../support/users";

const testKey = "test-key-encryption-secret-not-for-production";
const providerKey = "sk-ant-secret-never-exported";
const toolKey = "tvly-secret-never-exported";

function chatFor() {
  return createChat({
    databaseUrl: testDatabaseUrl,
    getUser: () => null,
    keyEncryptionSecrets: [testKey],
    basePath: "/api/chat",
  });
}

describe("createChat().exportUser", () => {
  it("exports every Branch with its parent chain, the Active Branch leaf and the Attachment by name and type", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Branched" });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    const first = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "First reply",
    });
    const second = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Second reply",
      active: true,
    });
    const file = await insertAttachment(owner, { filename: "notes.txt", mediaType: "text/plain" });
    await linkTestAttachments(question.id, [file.id]);

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.version).toBe(1);
    expect(exported.conversations).toHaveLength(1);
    const [exportedConv] = exported.conversations;
    expect(exportedConv).toMatchObject({ id: conv.id, title: "Branched", activeLeafId: second.id });
    const byId = new Map(exportedConv!.messages.map((m) => [m.id, m]));
    expect(exportedConv!.messages).toHaveLength(3);
    expect(byId.get(question.id)).toMatchObject({ parentId: null, role: "user" });
    expect(byId.get(first.id)).toMatchObject({ parentId: question.id, role: "assistant" });
    expect(byId.get(second.id)).toMatchObject({ parentId: question.id, role: "assistant" });
    expect(byId.get(question.id)!.attachments).toEqual([
      { filename: "notes.txt", mediaType: "text/plain" },
    ]);
    expect(byId.get(first.id)!.attachments).toEqual([]);
  });

  it("includes Projects, the pin and the settings, and never the Provider or Tool credentials", async () => {
    const owner = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({
      id: projectId,
      userId: owner.id,
      name: "Work",
      instructions: "Be brief.",
      defaultModel: "anthropic:claude-sonnet-5-5",
    });
    const pinnedAt = new Date("2026-10-09T10:00:00Z");
    await insertConversation(owner, { title: "Pinned", projectId, pinnedAt });
    await getTestDb().insert(userSettings).values({
      userId: owner.id,
      titleModel: "anthropic:title-model",
      instructions: "Answer in French.",
    });
    const deps = createTestDeps();
    await saveCredentials(deps, owner.id, {
      service: "anthropic",
      fields: { apiKey: providerKey },
      hint: "…-key",
      verified: true,
    });
    await saveCredentials(deps, owner.id, {
      service: "tavily",
      fields: { apiKey: toolKey },
      hint: "…-key",
      verified: true,
    });

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.projects).toEqual([
      expect.objectContaining({
        id: projectId,
        name: "Work",
        instructions: "Be brief.",
        defaultModel: "anthropic:claude-sonnet-5-5",
      }),
    ]);
    expect(exported.conversations[0]).toMatchObject({
      title: "Pinned",
      projectId,
      pinnedAt,
    });
    expect(exported.settings).toEqual({
      titleModel: "anthropic:title-model",
      instructions: "Answer in French.",
    });
    const text = JSON.stringify(exported);
    expect(text).not.toContain(providerKey);
    expect(text).not.toContain(toolKey);
  });

  it("includes the user's Shared links and leaves out other users' data", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const mine = await insertConversation(owner, { title: "Shared" });
    const leaf = await insertMessage({
      conversationId: mine.id,
      role: "user",
      text: "Hi",
      active: true,
    });
    const createdAt = new Date("2026-10-05T08:00:00Z");
    await getTestDb()
      .insert(sharedLink)
      .values({
        token: "b".repeat(22),
        conversationId: mine.id,
        leafMessageId: leaf.id,
        title: "Shared",
        createdAt,
      });
    await insertConversation(other, { title: "Theirs" });

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.conversations.map((c) => c.title)).toEqual(["Shared"]);
    expect(exported.sharedLinks).toEqual([
      { token: "b".repeat(22), conversationId: mine.id, createdAt },
    ]);
  });

  it("exports every Artifact with every version on every Branch", async () => {
    const owner = await insertUser();
    const bystander = await insertUser();
    const conv = await insertConversation(owner, { title: "Artifacts" });
    const question = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "Make it",
    });
    const firstReply = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Here",
    });
    const firstUpdate = await insertMessage({
      conversationId: conv.id,
      parentId: firstReply.id,
      role: "assistant",
      text: "Updated",
      active: true,
    });
    const siblingReply = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Another",
    });
    const siblingUpdate = await insertMessage({
      conversationId: conv.id,
      parentId: siblingReply.id,
      role: "assistant",
      text: "Another updated",
    });
    const createdAt = new Date("2026-10-06T09:00:00Z");
    const updatedAt = new Date("2026-10-06T09:05:00Z");
    await getTestDb()
      .insert(artifact)
      .values([
        { id: "main-art", conversationId: conv.id, kind: "code", createdAt },
        { id: "sibling-art", conversationId: conv.id, kind: "markdown", createdAt },
      ]);
    await getTestDb()
      .insert(artifactVersion)
      .values([
        {
          artifactId: "main-art",
          messageId: firstReply.id,
          number: 1,
          title: "Script",
          language: "python",
          content: "print(1)",
          createdAt,
        },
        {
          artifactId: "main-art",
          messageId: firstUpdate.id,
          number: 2,
          title: "Script",
          language: "python",
          content: "print(2)",
          createdAt: updatedAt,
        },
        {
          artifactId: "sibling-art",
          messageId: siblingReply.id,
          number: 1,
          title: "Notes",
          language: null,
          content: "# Notes",
          createdAt,
        },
        {
          artifactId: "sibling-art",
          messageId: siblingUpdate.id,
          number: 2,
          title: "Notes",
          language: null,
          content: "# Notes v2",
          createdAt: updatedAt,
        },
      ]);
    const theirs = await insertConversation(bystander, { title: "Theirs" });
    await getTestDb()
      .insert(artifact)
      .values({ id: "theirs-art", conversationId: theirs.id, kind: "svg", createdAt });

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.version).toBe(1);
    expect(exported.artifacts).toHaveLength(2);
    const byId = new Map(exported.artifacts.map((a) => [a.id, a]));
    expect(byId.get("main-art")).toEqual({
      id: "main-art",
      conversationId: conv.id,
      kind: "code",
      versions: [
        {
          number: 1,
          messageId: firstReply.id,
          title: "Script",
          language: "python",
          content: "print(1)",
          createdAt,
        },
        {
          number: 2,
          messageId: firstUpdate.id,
          title: "Script",
          language: "python",
          content: "print(2)",
          createdAt: updatedAt,
        },
      ],
    });
    expect(byId.get("sibling-art")).toMatchObject({
      kind: "markdown",
      versions: [
        { number: 1, messageId: siblingReply.id, content: "# Notes" },
        { number: 2, messageId: siblingUpdate.id, content: "# Notes v2" },
      ],
    });
    expect(byId.has("theirs-art")).toBe(false);
  });

  it("exports an empty artifacts list for a user with no Artifacts", async () => {
    const owner = await insertUser();
    await insertConversation(owner, { title: "Plain" });

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.artifacts).toEqual([]);
  });

  it("exports an empty document for an unknown user id", async () => {
    const exported = await chatFor().exportUser(randomUUID());

    expect(exported).toMatchObject({
      version: 1,
      conversations: [],
      projects: [],
      sharedLinks: [],
      artifacts: [],
      settings: { titleModel: null, instructions: null },
    });
  });
});
