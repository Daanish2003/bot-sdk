import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { fakeEmbeddingAdapter } from "../../../core/server/chat/fake-embedding-adapter";
import { knowledgeBlobKey } from "../../../core/server/blob/store";
import {
  conversation,
  message,
  project,
  job,
  knowledgeChunk,
  knowledgeFile,
  sharedLink,
} from "../../../core/server/db/schema";
import type { HostProvider } from "../../../core/server/deps";
import { knowledgeJobKey } from "../../../core/server/knowledge/process";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestDeps } from "../../support/deps";
import { drainJobs } from "../../support/jobs";
import { chatRpc } from "../../support/sdk";
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

describe("deleting a Project's Knowledge files", () => {
  const hostOpenAI: HostProvider = {
    provider: "openai",
    credentials: { apiKey: "sk-host-openai" },
    models: [],
    embeddingModels: [{ model: "text-embedding-3-small", pricePerMillionTokensUsd: 0.02 }],
  };
  const paragraphs = Array.from(
    { length: 12 },
    (_, n) => `Paragraph ${n} says ${"words ".repeat(90)}`,
  ).join("\n\n");

  it("deletes the files, their passages and their bytes, and cancels a queued job", async () => {
    const user = await insertUser();
    const deps = createTestDeps({
      hostProviders: [hostOpenAI],
      embeddingAdapterFor: () => fakeEmbeddingAdapter(),
    });
    const rpc = chatRpc({ user, deps });
    const { id: projectId } = await rpc.project.create({ name: "Thesis" });
    const ready = await rpc.knowledge.upload({
      projectId,
      file: new File([paragraphs], "notes.md", { type: "text/markdown" }),
    });
    await drainJobs({ deps });
    const queued = await rpc.knowledge.upload({
      projectId,
      file: new File(["Queued text."], "queued.md", { type: "text/markdown" }),
    });

    await rpc.project.delete({ id: projectId });

    expect(
      await getTestDb().select().from(knowledgeFile).where(eq(knowledgeFile.projectId, projectId)),
    ).toEqual([]);
    expect(
      await getTestDb().select().from(knowledgeChunk).where(eq(knowledgeChunk.fileId, ready.id)),
    ).toEqual([]);
    expect(await deps.blobStore.get(knowledgeBlobKey(ready.id))).toBeNull();
    expect(await deps.blobStore.get(knowledgeBlobKey(queued.id))).toBeNull();
    expect(await drainJobs({ deps })).toBe(0);
    const [queuedJob] = await getTestDb()
      .select({ status: job.status })
      .from(job)
      .where(eq(job.idempotencyKey, knowledgeJobKey(queued.id)));
    expect(queuedJob).toMatchObject({ status: "cancelled" });
  });
});
