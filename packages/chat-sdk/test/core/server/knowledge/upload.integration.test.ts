import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { knowledgeBlobKey } from "../../../../core/server/blob/store";
import { fakeEmbeddingAdapter } from "../../../../core/server/chat/fake-embedding-adapter";
import { saveCredentials } from "../../../../core/server/credentials/store";
import { blob } from "../../../../core/server/db/schema/blob";
import { project } from "../../../../core/server/db/schema/chat";
import { userCredentials } from "../../../../core/server/db/schema/credentials";
import { knowledgeChunk, knowledgeFile } from "../../../../core/server/db/schema/knowledge";
import { usage } from "../../../../core/server/db/schema/usage";
import type { AppDeps, HostProvider } from "../../../../core/server/deps";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { maxKnowledgeFileBytes } from "../../../../core/shared/knowledge/kinds";
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

/** A signed-in user with a Project, on a test deps whose embeddings are the fake adapter. */
async function setup(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  const user = await insertUser();
  const embeddings = fakeEmbeddingAdapter();
  const deps = createTestDeps({
    hostProviders: [hostOpenAI],
    embeddingAdapterFor: () => embeddings,
    ...overrides,
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

/** Gives the user their own OpenAI key, which the Project's Model then runs on. */
async function saveOwnOpenAIKey(deps: AppDeps, userId: string) {
  await saveCredentials(deps, userId, {
    service: "openai",
    fields: { apiKey: "sk-own-openai" },
    hint: "…-openai",
    verified: true,
  });
}

/** Records spend of `costMicros` in the user's Quota window, as a finished Run would. */
async function spend(userId: string, costMicros: number) {
  await getTestDb().insert(usage).values({
    id: uuidv7(),
    userId,
    kind: "run",
    model: "anthropic:claude-sonnet-5-5",
    inputTokens: 0,
    outputTokens: 0,
    costMicros,
    estimated: false,
  });
}

describe("uploading a Knowledge file", () => {
  it("is Processing on upload, then Ready with its passage count, with its bytes kept", async () => {
    const { deps, rpc, projectId, embeddings } = await setup();

    const added = await rpc.knowledge.upload({
      projectId,
      file: markdown(paragraphs(12)),
    });

    expect(added).toMatchObject({
      name: "notes.md",
      mediaType: "text/markdown",
      status: "processing",
      chunkCount: null,
    });
    expect(await rpc.knowledge.list({ projectId })).toMatchObject({
      files: [{ id: added.id, status: "processing" }],
    });

    expect(await drainJobs({ deps })).toBe(1);

    const { files } = await rpc.knowledge.list({ projectId });
    expect(files).toEqual([
      expect.objectContaining({ id: added.id, status: "ready", failureCode: null }),
    ]);
    const passages = files[0]!.chunkCount!;
    expect(passages).toBeGreaterThan(1);
    const stored = await getTestDb()
      .select()
      .from(knowledgeChunk)
      .where(eq(knowledgeChunk.fileId, added.id));
    expect(stored).toHaveLength(passages);
    expect(stored[0]!.embedding).toHaveLength(1536);
    expect(embeddings.calls.flatMap((call) => call.inputs)).toHaveLength(passages);
    const [bytes] = await getTestDb()
      .select({ key: blob.key })
      .from(blob)
      .where(eq(blob.key, knowledgeBlobKey(added.id)));
    expect(bytes?.key).toBe(knowledgeBlobKey(added.id));
  });

  it("gives the Project the default embedding Model on its first upload, and keeps it", async () => {
    const { rpc, projectId } = await setup();

    await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(2)) });

    const { embeddingModel, currentModel } = await rpc.knowledge.list({ projectId });
    expect(embeddingModel).toBe("openai:text-embedding-3-small");
    expect(currentModel).toEqual({ id: "openai:text-embedding-3-small", onHostCredentials: true });
    const [row] = await getTestDb()
      .select({ embeddingModel: project.embeddingModel })
      .from(project)
      .where(eq(project.id, projectId));
    expect(row?.embeddingModel).toBe("openai:text-embedding-3-small");
  });

  it("goes to Failed with 'no text' for a file with nothing but whitespace", async () => {
    const { deps, rpc, projectId } = await setup();
    const added = await rpc.knowledge.upload({
      projectId,
      file: markdown("   \n\n  ", "blank.txt"),
    });

    await drainJobs({ deps });

    const { files } = await rpc.knowledge.list({ projectId });
    expect(files).toEqual([
      expect.objectContaining({ id: added.id, status: "failed", failureCode: "no_text" }),
    ]);
  });

  it("goes to Failed for 'no credentials' when the Model's key is gone before processing", async () => {
    const { rpc, projectId } = await setup();
    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(3)) });

    // The job runs on deps that no longer offer the Model, as after the Host drops its key.
    await drainJobs({ deps: createTestDeps({ hostProviders: [] }) });

    const { files } = await rpc.knowledge.list({ projectId });
    expect(files).toEqual([
      expect.objectContaining({ id: added.id, status: "failed", failureCode: "no_credentials" }),
    ]);
  });

  it("refuses an upload when the user has no Model to embed with, saying to add a key", async () => {
    const { rpc, projectId } = await setup({ hostProviders: [] });

    const attempt = rpc.knowledge.upload({ projectId, file: markdown("Some notes.") });

    await expect(attempt).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(codeOf(await attempt.catch((error: unknown) => error))).toBe("error.knowledgeNoModel");
  });

  it("refuses an upload on Host credentials with 402 once the Quota is spent, and finishes the files already processing", async () => {
    // A budget of 100 micros: the first upload is under it, then the spend takes the window over.
    const { user, deps, rpc, projectId } = await setup({
      getQuota: async () => ({ window: "day", budgetUsd: 0.0001 }),
    });
    const first = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(3)) });
    await spend(user.id, 100);

    const refused = await rpc.knowledge
      .upload({ projectId, file: markdown(paragraphs(3), "second.md") })
      .catch((e: unknown) => e);

    expect(refused).toMatchObject({ status: 402 });
    expect(codeOf(refused)).toBe("error.quotaSpent");
    expect(await drainJobs({ deps })).toBe(1);
    expect((await rpc.knowledge.list({ projectId })).files).toEqual([
      expect.objectContaining({ id: first.id, status: "ready" }),
    ]);
  });

  it("does not refuse or meter an upload on the user's own key, even with the Quota spent", async () => {
    const { user, deps, rpc, projectId } = await setup({
      getQuota: async () => ({ window: "day", budgetUsd: 0.0001 }),
    });
    await saveOwnOpenAIKey(deps, user.id);
    await spend(user.id, 100);

    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(3)) });
    await drainJobs({ deps });

    expect((await rpc.knowledge.list({ projectId })).files).toEqual([
      expect.objectContaining({ id: added.id, status: "ready" }),
    ]);
    const embeddingRows = await getTestDb()
      .select({ id: usage.id })
      .from(usage)
      .where(eq(usage.kind, "embedding"));
    expect(embeddingRows).toEqual([]);
  });

  it("switches between the user's own key and Host credentials for the same Model without re-embedding", async () => {
    const { user, deps, rpc, projectId, embeddings } = await setup();
    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(3)) });
    await drainJobs({ deps });
    const before = await rpc.knowledge.list({ projectId });
    const embeddedBefore = embeddings.calls.length;

    await saveOwnOpenAIKey(deps, user.id);
    const own = await rpc.knowledge.list({ projectId });
    await getTestDb().delete(userCredentials).where(eq(userCredentials.userId, user.id));
    const hostAgain = await rpc.knowledge.list({ projectId });

    expect(before.currentModel).toEqual({
      id: "openai:text-embedding-3-small",
      onHostCredentials: true,
    });
    expect(own.currentModel).toEqual({
      id: "openai:text-embedding-3-small",
      onHostCredentials: false,
    });
    expect(hostAgain.currentModel).toEqual(before.currentModel);
    for (const list of [own, hostAgain]) {
      expect(list.embeddingModel).toBe("openai:text-embedding-3-small");
      expect(list.files).toEqual([
        expect.objectContaining({
          id: added.id,
          status: "ready",
          chunkCount: before.files[0]!.chunkCount,
        }),
      ]);
    }
    expect(embeddings.calls).toHaveLength(embeddedBefore);
  });

  it("keeps files Ready, with no current Model, once the Model's key is gone", async () => {
    const { user, deps, rpc, projectId } = await setup();
    const added = await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(3)) });
    await drainJobs({ deps });

    const withoutKey = chatRpc({ user, deps: createTestDeps({ hostProviders: [] }) });
    const after = await withoutKey.knowledge.list({ projectId });

    expect(after).toMatchObject({
      embeddingModel: "openai:text-embedding-3-small",
      currentModel: null,
      files: [{ id: added.id, status: "ready", failureCode: null }],
    });
  });

  it("refuses a file over 20 MB", async () => {
    const { rpc, projectId } = await setup();
    const big = new File([new Uint8Array(maxKnowledgeFileBytes + 1)], "big.md", {
      type: "text/markdown",
    });

    const error = await rpc.knowledge.upload({ projectId, file: big }).catch((e: unknown) => e);

    expect(codeOf(error)).toBe("error.knowledgeFileTooLarge");
  });

  it("accepts a 20 MB body: the handler passes a Knowledge file of exactly the limit (ADR 0015)", async () => {
    const { rpc, projectId } = await setup();
    const exact = new File([new Uint8Array(maxKnowledgeFileBytes).fill(0x61)], "exact.md", {
      type: "text/markdown",
    });

    const added = await rpc.knowledge.upload({ projectId, file: exact });

    expect(added).toMatchObject({ name: "exact.md", size: maxKnowledgeFileBytes });
  }, 120_000);

  it("refuses a file that is neither Markdown nor text", async () => {
    const { rpc, projectId } = await setup();
    const pdf = new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" });

    const error = await rpc.knowledge.upload({ projectId, file: pdf }).catch((e: unknown) => e);

    expect(codeOf(error)).toBe("error.knowledgeFileNotSupported");
  });

  it("refuses a text file that isn't UTF-8", async () => {
    const { rpc, projectId } = await setup();
    const latin = new File([new Uint8Array([0xff, 0xfe, 0x00, 0x41])], "notes.txt", {
      type: "text/plain",
    });

    const error = await rpc.knowledge.upload({ projectId, file: latin }).catch((e: unknown) => e);

    expect(codeOf(error)).toBe("error.knowledgeFileNotUtf8");
  });

  it("refuses the 101st file in a Project", async () => {
    const { user, rpc, projectId } = await setup();
    await getTestDb()
      .insert(knowledgeFile)
      .values(
        Array.from({ length: 100 }, (_, n) => ({
          id: randomUUID(),
          userId: user.id,
          projectId,
          name: `file-${n}.md`,
          mediaType: "text/markdown",
          size: 1,
        })),
      );

    const error = await rpc.knowledge
      .upload({ projectId, file: markdown("One more.") })
      .catch((e: unknown) => e);

    expect(codeOf(error)).toBe("error.knowledgeFileLimit");
  });

  it("keeps the Project's Model fixed once it has a file, and only offers Models the user can use", async () => {
    const { rpc, projectId } = await setup();

    const unavailable = await rpc.knowledge
      .setModel({ projectId, model: "openai:text-embedding-3-large" })
      .catch((e: unknown) => e);
    expect(codeOf(unavailable)).toBe("error.knowledgeModelNotAvailable");

    await rpc.knowledge.setModel({ projectId, model: "openai:text-embedding-3-small" });
    await rpc.knowledge.upload({ projectId, file: markdown(paragraphs(2)) });
    const locked = await rpc.knowledge
      .setModel({ projectId, model: "openai:text-embedding-3-small" })
      .catch((e: unknown) => e);
    expect(codeOf(locked)).toBe("error.knowledgeModelLocked");
  });

  it("is not found to another user, and writes nothing to the owner's Project", async () => {
    const { rpc, deps, projectId } = await setup();
    const stranger = chatRpc({ user: await insertUser(), deps });

    const list = await stranger.knowledge.list({ projectId }).catch((e: unknown) => e);
    const upload = await stranger.knowledge
      .upload({ projectId, file: markdown("Not mine.") })
      .catch((e: unknown) => e);

    expect(codeOf(list)).toBe("error.projectNotFound");
    expect(codeOf(upload)).toBe("error.projectNotFound");
    expect((await rpc.knowledge.list({ projectId })).files).toEqual([]);
  });
});
