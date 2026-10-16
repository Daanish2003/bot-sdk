import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { fakeEmbeddingAdapter } from "../../../../core/server/chat/fake-embedding-adapter";
import { knowledgeBlobKey } from "../../../../core/server/blob/store";
import { blob, job, knowledgeChunk, knowledgeFile } from "../../../../core/server/db/schema";
import type { HostProvider } from "../../../../core/server/deps";
import { createTestDeps } from "../../../support/deps";
import { drainJobs } from "../../../support/jobs";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

/** The Host offers OpenAI's small embedding Model on its own key. */
const hostOpenAI: HostProvider = {
  provider: "openai",
  credentials: { apiKey: "sk-host-openai" },
  models: [],
  embeddingModels: [{ model: "text-embedding-3-small", pricePerMillionTokensUsd: 0.02 }],
};

/** A signed-in user with a Project, on test deps whose embeddings are the fake adapter. */
async function setup() {
  const user = await insertUser();
  const embeddings = fakeEmbeddingAdapter();
  const deps = createTestDeps({
    hostProviders: [hostOpenAI],
    embeddingAdapterFor: () => embeddings,
  });
  const rpc = chatRpc({ user, deps });
  const { id: projectId } = await rpc.project.create({ name: "Thesis" });
  return { user, deps, rpc, projectId, embeddings };
}

/** Paragraphs of about 500 characters, numbered so each reads differently. */
function paragraphs(count: number) {
  return Array.from({ length: count }, (_, n) => `Paragraph ${n} says ${"words ".repeat(90)}`).join(
    "\n\n",
  );
}

const markdown = (text: string, name = "notes.md") =>
  new File([text], name, { type: "text/markdown" });

/** The error code the server sent, as the client sees it on a failed call. */
const codeOf = (error: unknown) => (error as { data?: { code?: string } }).data?.code;

/** The one Knowledge job's row, as the job table holds it. */
async function knowledgeJobRow() {
  const [row] = await getTestDb()
    .select({ status: job.status, attempts: job.attempts, lastError: job.lastError })
    .from(job)
    .where(eq(job.name, "knowledge.process"));
  return row;
}

async function chunksOf(fileId: string) {
  return getTestDb().select().from(knowledgeChunk).where(eq(knowledgeChunk.fileId, fileId));
}

async function blobExists(fileId: string) {
  const rows = await getTestDb()
    .select({ key: blob.key })
    .from(blob)
    .where(eq(blob.key, knowledgeBlobKey(fileId)));
  return rows.length > 0;
}

async function fileRowExists(fileId: string) {
  const rows = await getTestDb()
    .select({ id: knowledgeFile.id })
    .from(knowledgeFile)
    .where(eq(knowledgeFile.id, fileId));
  return rows.length > 0;
}

describe("a failed Knowledge file", () => {
  it("is Failed for 'unreadable' after one attempt when its bytes are gone", async () => {
    const { deps, rpc, projectId } = await setup();
    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(3)) });
    await getTestDb()
      .delete(blob)
      .where(eq(blob.key, knowledgeBlobKey(added.id)));

    await drainJobs({ deps });

    const { files } = await rpc.knowledge.list({ projectId });
    expect(files).toEqual([
      expect.objectContaining({ id: added.id, status: "failed", failureCode: "unreadable" }),
    ]);
    expect(await knowledgeJobRow()).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("is retried without re-uploading: the kept original is processed again, and becomes Ready", async () => {
    const { user, rpc, projectId } = await setup();
    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(3)) });
    // Without a key the Model can't embed, so the file fails for 'no credentials'.
    await drainJobs({ deps: createTestDeps({ hostProviders: [] }) });
    expect((await rpc.knowledge.list({ projectId })).files[0]).toMatchObject({
      status: "failed",
      failureCode: "no_credentials",
    });

    const retryDeps = createTestDeps({ hostProviders: [hostOpenAI] });
    await chatRpc({ user, deps: retryDeps }).knowledge.retry({ projectId, fileId: added.id });

    expect((await rpc.knowledge.list({ projectId })).files[0]).toMatchObject({
      id: added.id,
      status: "processing",
      failureCode: null,
    });
    expect(await drainJobs({ deps: retryDeps })).toBe(1);
    const { files } = await rpc.knowledge.list({ projectId });
    expect(files[0]).toMatchObject({ id: added.id, status: "ready", failureCode: null });
    expect(files[0]!.chunkCount).toBeGreaterThan(0);
  });

  it("can't be retried unless it is Failed", async () => {
    const { deps, rpc, projectId } = await setup();
    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(2)) });
    await drainJobs({ deps });

    const error = await rpc.knowledge
      .retry({ projectId, fileId: added.id })
      .catch((e: unknown) => e);

    expect(codeOf(error)).toBe("error.knowledgeFileNotFailed");
  });

  it("can't be retried or deleted by another user, or when it isn't in this Project", async () => {
    const { deps, rpc, projectId } = await setup();
    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(2)) });
    const stranger = chatRpc({ user: await insertUser(), deps });
    const { id: otherProjectId } = await rpc.project.create({ name: "Other" });

    const strangerRetry = await stranger.knowledge
      .retry({ projectId, fileId: added.id })
      .catch((e: unknown) => e);
    const strangerDelete = await stranger.knowledge
      .delete({ projectId, fileId: added.id })
      .catch((e: unknown) => e);
    const wrongProject = await rpc.knowledge
      .delete({ projectId: otherProjectId, fileId: added.id })
      .catch((e: unknown) => e);

    expect(codeOf(strangerRetry)).toBe("error.projectNotFound");
    expect(codeOf(strangerDelete)).toBe("error.projectNotFound");
    expect(codeOf(wrongProject)).toBe("error.knowledgeFileNotFound");
    expect(await fileRowExists(added.id)).toBe(true);
  });
});

describe("deleting a Knowledge file", () => {
  it("removes the file, its passages and its blob", async () => {
    const { deps, rpc, projectId } = await setup();
    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(12)) });
    await drainJobs({ deps });
    expect(await chunksOf(added.id)).not.toHaveLength(0);

    await rpc.knowledge.delete({ projectId, fileId: added.id });

    expect((await rpc.knowledge.list({ projectId })).files).toEqual([]);
    expect(await fileRowExists(added.id)).toBe(false);
    expect(await chunksOf(added.id)).toEqual([]);
    expect(await blobExists(added.id)).toBe(false);
  });

  it("stops a file that is still queued: its job is cancelled, so it never runs", async () => {
    const { deps, rpc, projectId } = await setup();
    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(12)) });

    await rpc.knowledge.delete({ projectId, fileId: added.id });

    expect(await drainJobs({ deps })).toBe(0);
    expect(await knowledgeJobRow()).toMatchObject({ status: "cancelled" });
    expect(await fileRowExists(added.id)).toBe(false);
    expect(await chunksOf(added.id)).toEqual([]);
    expect(await blobExists(added.id)).toBe(false);
  });

  it("while the file is being embedded, writes no passages after the delete", async () => {
    const { deps, rpc, projectId, embeddings } = await setup();
    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(12)) });
    // The delete lands while the job is inside its embedding call, after the job has started.
    const embedOnce = embeddings.createEmbeddings.bind(embeddings);
    let deleteDuringEmbedding = true;
    Object.assign(embeddings, {
      createEmbeddings: async (request: Parameters<typeof embedOnce>[0]) => {
        if (deleteDuringEmbedding) {
          deleteDuringEmbedding = false;
          await rpc.knowledge.delete({ projectId, fileId: added.id });
        }
        return embedOnce(request);
      },
    });

    await drainJobs({ deps });

    expect(embeddings.calls).toHaveLength(1);
    expect(await fileRowExists(added.id)).toBe(false);
    expect(await chunksOf(added.id)).toEqual([]);
    expect(await knowledgeJobRow()).toMatchObject({ status: "cancelled" });
  });

  it("refuses a file that isn't in the Project", async () => {
    const { rpc, projectId } = await setup();

    const error = await rpc.knowledge
      .delete({ projectId, fileId: "00000000-0000-4000-8000-000000000042" })
      .catch((e: unknown) => e);

    expect(codeOf(error)).toBe("error.knowledgeFileNotFound");
  });
});
