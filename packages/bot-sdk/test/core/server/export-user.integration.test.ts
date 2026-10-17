import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { assistant } from "../../../plugins/assistant/server/plugin";
import { runner } from "../../../plugins/runner/server/plugin";
import { models } from "../../../plugins/models/server/plugin";
import { saveCredentials } from "../../../plugins/models/server/credentials/store";
import {
  artifact,
  artifactVersion,
  project,
  knowledgeFile,
  memory,
  savedPrompt,
  sharedLink,
  userSettings,
} from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { insertAttachment, linkTestAttachments } from "../../support/attachments";
import { fakePngBase64 } from "../../../plugins/models/server/fake-image-adapter";
import { insertConversation, insertMessage } from "../../support/conversations";
import { insertMemory } from "../../support/memories";
import { insertGeneratedImage } from "../../support/generated-images";
import { createTestSdk } from "../../support/deps";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser } from "../../support/users";

const testKey = "test-key-encryption-secret-not-for-production";
const providerKey = "sk-ant-secret-never-exported";
const toolKey = "tvly-secret-never-exported";

function chatFor() {
  return createBotSdk({
    databaseUrl: testDatabaseUrl,
    getUser: () => null,
    keyEncryptionSecrets: [testKey],
    basePath: "/api/chat",
    plugins: [models(), runner(), assistant()],
  });
}

describe("createBotSdk().exportUser", () => {
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
      backgroundModel: "anthropic:background-model",
      imageModel: "openai:gpt-image-2",
      instructions: "Answer in French.",
    });
    const deps = createTestSdk();
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
      backgroundModel: "anthropic:background-model",
      imageModel: "openai:gpt-image-2",
      instructions: "Answer in French.",
      memoryEnabled: true,
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

  it("includes each Message's Rating, null while a reply is unrated", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Rated" });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    const up = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Up",
      rating: "up",
      ratedAt: new Date(),
    });
    const unrated = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Plain",
      active: true,
    });

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.version).toBe(1);
    const byId = new Map(exported.conversations[0]!.messages.map((m) => [m.id, m]));
    expect(byId.get(up.id)).toMatchObject({ rating: "up" });
    expect(byId.get(unrated.id)).toMatchObject({ rating: null });
    expect(byId.get(question.id)).toMatchObject({ rating: null });
  });

  it("says which Conversations are archived, with the format version unchanged", async () => {
    const owner = await insertUser();
    const archivedAt = new Date("2026-10-11T09:00:00Z");
    await insertConversation(owner, { title: "Archived", archivedAt });
    await insertConversation(owner, { title: "Live" });

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.version).toBe(1);
    const byTitle = (title: string) => exported.conversations.find((conv) => conv.title === title);
    expect(byTitle("Archived")?.archivedAt).toEqual(archivedAt);
    expect(byTitle("Live")?.archivedAt).toBeNull();
  });

  it("includes the Saved prompts by name, text and created time", async () => {
    const owner = await insertUser();
    const createdAt = new Date("2026-10-05T09:00:00Z");
    await getTestDb()
      .insert(savedPrompt)
      .values({ id: uuidv7(), userId: owner.id, name: "review", text: "Review this.", createdAt });

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.savedPrompts).toEqual([{ name: "review", text: "Review this.", createdAt }]);
    expect(exported.version).toBe(1);
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
      settings: {
        backgroundModel: null,
        imageModel: null,
        instructions: null,
        memoryEnabled: true,
      },
    });
  });
});

describe("createBotSdk().exportUser, Temporary Conversations", () => {
  it("includes an existing Temporary Conversation, marked temporary", async () => {
    const owner = await insertUser();
    const temporary = await insertConversation(owner, { temporary: true, title: null });
    await insertMessage({ conversationId: temporary.id, role: "user", text: "Private" });
    const ordinary = await insertConversation(owner, { title: "Ordinary" });

    const exported = await chatFor().exportUser(owner.id);

    const byId = new Map(exported.conversations.map((row) => [row.id, row]));
    expect(byId.get(temporary.id)).toMatchObject({ temporary: true, messages: [{ role: "user" }] });
    expect(byId.get(ordinary.id)).toMatchObject({ temporary: false });
  });
});

describe("createBotSdk().exportUser, Generated images", () => {
  it("lists each image by id, Model and prompt, with no bytes", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const conv = await insertConversation(owner, { title: "Pictures" });
    const imageId = await insertGeneratedImage(deps, owner, conv.id, { prompt: "a red bicycle" });

    const exported = await chatFor().exportUser(owner.id);

    const reply = exported.conversations[0]!.messages.find((row) => row.role === "assistant");
    expect(reply?.generatedImages).toEqual([
      { id: imageId, model: "openai:gpt-image-1-mini", prompt: "a red bicycle" },
    ]);
    expect(JSON.stringify(exported)).not.toContain(fakePngBase64);
  });
});

describe("createBotSdk().exportUser, a Hidden reply's Rating", () => {
  it("leaves the Rating out of a Hidden reply", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Hidden rating" });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    const hidden = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      rating: "up",
      ratedAt: new Date(),
      hiddenAt: new Date(),
      hiddenReason: "policy",
      active: true,
    });

    const exported = await chatFor().exportUser(owner.id);

    const found = exported.conversations[0]!.messages.find((m) => m.id === hidden.id);
    expect(found).toMatchObject({ hidden: true, rating: null });
  });
});

describe("createBotSdk().exportUser, Memories", () => {
  it("includes every Memory, valid and outdated, with its source Conversation and replacement", async () => {
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Chat" });
    const replaced = await insertMemory(owner, {
      conversationId: conv.id,
      text: "Runs 5k in 25 minutes",
      origin: "extracted",
      invalidAt: new Date("2026-10-02T10:00:00Z"),
      createdAt: new Date("2026-09-01T10:00:00Z"),
      updatedAt: new Date("2026-10-02T10:00:00Z"),
    });
    const current = await insertMemory(owner, {
      conversationId: conv.id,
      text: "Runs 5k in 22 minutes",
      origin: "said",
      createdAt: new Date("2026-10-02T10:00:00Z"),
      updatedAt: new Date("2026-10-02T10:00:00Z"),
    });
    await getTestDb()
      .update(memory)
      .set({ replacedById: current.id })
      .where(eq(memory.id, replaced.id));
    await getTestDb().insert(userSettings).values({ userId: owner.id, memoryEnabled: false });

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.memories).toEqual([
      {
        id: replaced.id,
        text: "Runs 5k in 25 minutes",
        origin: "extracted",
        conversationId: conv.id,
        replacedById: current.id,
        invalidAt: new Date("2026-10-02T10:00:00Z"),
        createdAt: new Date("2026-09-01T10:00:00Z"),
        updatedAt: new Date("2026-10-02T10:00:00Z"),
      },
      {
        id: current.id,
        text: "Runs 5k in 22 minutes",
        origin: "said",
        conversationId: conv.id,
        replacedById: null,
        invalidAt: null,
        createdAt: new Date("2026-10-02T10:00:00Z"),
        updatedAt: new Date("2026-10-02T10:00:00Z"),
      },
    ]);
    expect(exported.settings.memoryEnabled).toBe(false);
  });

  it("leaves out other users' Memories", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const conv = await insertConversation(other, { title: "Theirs" });
    await insertMemory(other, { conversationId: conv.id, text: "Not yours" });

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.memories).toEqual([]);
  });
});

describe("createBotSdk().exportUser, Knowledge files", () => {
  it("lists each Knowledge file by name, type and Project, with no bytes or passages", async () => {
    const owner = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: owner.id, name: "Thesis" });
    await getTestDb().insert(knowledgeFile).values({
      id: uuidv7(),
      userId: owner.id,
      projectId,
      name: "draft.md",
      mediaType: "text/markdown",
      size: 12,
    });

    const exported = await chatFor().exportUser(owner.id);

    expect(exported.knowledgeFiles).toEqual([
      { name: "draft.md", mediaType: "text/markdown", projectId },
    ]);
  });
});
