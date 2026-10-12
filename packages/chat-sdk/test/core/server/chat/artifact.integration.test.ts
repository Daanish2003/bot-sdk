import { storedParts } from "../../../../core/shared/message-parts";
import { artifact, artifactVersion } from "../../../../core/server/db/schema/artifact";
import { message } from "../../../../core/server/db/schema/chat";
import { createArtifactTool } from "../../../../core/server/chat/artifact-tool";
import { createPartsBuilder } from "../../../../core/shared/chat/parts";
import { createToolBudget } from "../../../../core/server/chat/host-tools";
import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps } from "../../../../core/server/deps";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { curatedModels } from "../../../../core/shared/chat/models";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { sendAs, chatRpc } from "../../../support/sdk";
import { insertUser, type TestUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";

const createCall = (
  id: string,
  input: { kind: string; title: string; content: string; language?: string },
  split?: number,
) => toolCall({ id, name: "create_artifact", input, split });

const htmlPage = { kind: "html" as const, title: "Landing page", content: "<h1>Hi</h1>" };

/** A signed-in user with Anthropic credentials, and a fake adapter playing `rounds`. */
async function setup({
  rounds,
  artifacts = true,
  deps: overrides = {},
}: {
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"];
  artifacts?: boolean;
  deps?: TestDepsOverrides;
}) {
  const user: TestUser = await insertUser();
  const fake = createFakeAdapter({ rounds });
  const deps = createTestDeps({ adapterFor: () => fake.adapter, artifacts, ...overrides });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  // Titled, so a complete run doesn't call the adapter again to title it (#26).
  const conv = await insertConversation(user, { title: "Artifacts" });
  const send = (command: { text?: string; model?: string } = {}) =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "Make me a page",
            attachmentIds: [],
            model: anthropicModel,
            webSearch: false,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
  return { user, deps, fake, conv, send };
}

/** The Model's answer to each tool call, as the next round of the Model received it. */
const toolResult = (fake: ReturnType<typeof createFakeAdapter>, round: number) =>
  fake.calls[round]!.messages.at(-1);

async function repliesOf(deps: AppDeps, conversationId: string) {
  const rows = await deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.filter((row) => row.role === "assistant");
}

const replyOf = async (deps: AppDeps, conversationId: string) =>
  (await repliesOf(deps, conversationId)).at(-1)!;

const artifactRowsOf = (deps: AppDeps, conversationId: string) =>
  deps.db.select().from(artifact).where(eq(artifact.conversationId, conversationId));

const versionRowsOf = (deps: AppDeps) => deps.db.select().from(artifactVersion);

describe("create_artifact in a reply", () => {
  it("stores one artifact and its version 1, and answers with the id and version", async () => {
    const { deps, fake, conv, send } = await setup({
      rounds: [round(text("Here. "), createCall("call-1", htmlPage)), round(text("Done."))],
    });

    await (await send()).text();

    const [row] = await artifactRowsOf(deps, conv.id);
    expect(row).toMatchObject({ kind: "html", conversationId: conv.id });
    expect(await versionRowsOf(deps)).toEqual([
      expect.objectContaining({
        artifactId: row!.id,
        messageId: (await replyOf(deps, conv.id)).id,
        number: 1,
        title: "Landing page",
        language: null,
        content: "<h1>Hi</h1>",
      }),
    ]);
    expect(toolResult(fake, 1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify({ artifactId: row!.id, version: 1 }),
    });
  });

  it("stores a slim artifact part in the reply, between the text around it", async () => {
    const { deps, conv, send } = await setup({
      rounds: [round(text("Here. "), createCall("call-1", htmlPage)), round(text("Done."))],
    });

    await (await send()).text();

    const [row] = await artifactRowsOf(deps, conv.id);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        { type: "text", text: "Here. " },
        {
          type: "artifact",
          artifactId: row!.id,
          version: 1,
          title: "Landing page",
          kind: "html",
          state: "done",
        },
        { type: "text", text: "Done." },
      ]),
    });
  });

  it("keeps the language of a code Artifact, and no content in the reply", async () => {
    const { deps, conv, send } = await setup({
      rounds: [
        round(
          createCall("call-1", {
            kind: "code",
            title: "Sorter",
            language: "python",
            content: "print('sorted')",
          }),
        ),
        round(text("Done.")),
      ],
    });

    await (await send()).text();

    const [version] = await versionRowsOf(deps);
    expect(version).toMatchObject({ title: "Sorter", language: "python" });
    expect(JSON.stringify((await replyOf(deps, conv.id)).parts)).not.toContain("print('sorted')");
  });

  it("refuses content over 256 KB and an unknown kind: an error result, and nothing is stored", async () => {
    const { deps, fake, conv, send } = await setup({
      rounds: [
        round(
          createCall("call-1", {
            kind: "html",
            title: "Too big",
            content: "x".repeat(256 * 1024 + 1),
          }),
        ),
        round(createCall("call-2", { kind: "pdf", title: "Wrong kind", content: "x" })),
        round(text("I could not save it.")),
      ],
    });

    await (await send()).text();

    expect(String(toolResult(fake, 1)?.content)).toContain("validation failed");
    expect(String(toolResult(fake, 2)?.content)).toContain("validation failed");
    expect(await artifactRowsOf(deps, conv.id)).toEqual([]);
    expect(await versionRowsOf(deps)).toEqual([]);
  });

  it("stores nothing when the Run is stopped while the Artifact is written", async () => {
    const { deps, conv, send } = await setup({ rounds: [round(text("Done."))] });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);
    // The write commits, then the Run's signal aborts: the version is taken back, as a Stop does.
    const controller = new AbortController();
    const db = new Proxy(deps.db, {
      get(target, key, receiver) {
        if (key !== "transaction") return Reflect.get(target, key, receiver);
        return async (...args: Parameters<typeof target.transaction>) => {
          const result = await target.transaction(...args);
          controller.abort();
          return result;
        };
      },
    });
    const tool = createArtifactTool({
      deps: { ...deps, db },
      messageId: reply.id,
      conversationId: conv.id,
      parts: createPartsBuilder(),
      onChange: () => {},
      budget: createToolBudget(0),
    });

    await expect(
      tool.execute!(htmlPage, { toolCallId: "call-1", abortSignal: controller.signal } as never),
    ).rejects.toThrow("stopped");
    expect(await artifactRowsOf(deps, conv.id)).toEqual([]);
    expect(await versionRowsOf(deps)).toEqual([]);
  });

  it("is not offered when Artifacts are off", async () => {
    const { fake, send } = await setup({ artifacts: false, rounds: [round(text("Sure."))] });

    await (await send()).text();

    expect((fake.calls[0]?.tools ?? []).map((tool) => tool.name)).not.toContain("create_artifact");
  });

  describe("when the Model has no tool support", () => {
    const toolless = { ...curatedModels[0]!, id: "anthropic:toolless-test", tools: false };
    afterEach(() => {
      curatedModels.splice(curatedModels.indexOf(toolless), 1);
    });

    it("is not offered, and the reply completes as before", async () => {
      curatedModels.push(toolless);
      const { fake, deps, conv, send } = await setup({ rounds: [round(text("Sure."))] });

      const response = await send({ model: toolless.id });
      await response.text();

      expect(response.status).toBe(200);
      expect((fake.calls[0]?.tools ?? []).map((tool) => tool.name)).not.toContain(
        "create_artifact",
      );
      expect(await replyOf(deps, conv.id)).toMatchObject({ status: "complete" });
    });
  });

  it("counts each Artifact call against the reply's tool budget", async () => {
    const calls = Array.from({ length: 11 }, (_, i) =>
      createCall(`call-${i + 1}`, { ...htmlPage, title: `Page ${i + 1}` }),
    );
    const { deps, fake, conv, send } = await setup({
      rounds: [round(...calls), round(text("Done."))],
    });

    await (await send()).text();

    expect(await artifactRowsOf(deps, conv.id)).toHaveLength(10);
    expect(
      fake.calls[1]!.messages.find((m) => m.role === "tool" && m.toolCallId === "call-11"),
    ).toMatchObject({
      role: "tool",
      toolCallId: "call-11",
      content: JSON.stringify({ error: "tool call limit reached" }),
    });
  });

  it("streams its arguments in several deltas and still saves the Artifact", async () => {
    const { deps, conv, send } = await setup({
      rounds: [round(createCall("call-1", htmlPage, 5)), round(text("Done."))],
    });

    await (await send()).text();

    const [row] = await artifactRowsOf(deps, conv.id);
    expect(row).toMatchObject({ kind: "html" });
    const [version] = await versionRowsOf(deps);
    expect(version).toMatchObject({ content: "<h1>Hi</h1>", title: "Landing page" });
  });
});

describe("the artifact.version read", () => {
  async function savedArtifact() {
    const { user, deps, conv, send } = await setup({
      rounds: [round(createCall("call-1", htmlPage)), round(text("Done."))],
    });
    await (await send()).text();
    const [row] = await artifactRowsOf(deps, conv.id);
    return { user, deps, artifactId: row!.id };
  }

  it("returns the version's content to the owner of its Conversation", async () => {
    const { user, deps, artifactId } = await savedArtifact();

    const version = await chatRpc({ user, deps }).artifact.version({ artifactId, number: 1 });

    expect(version).toMatchObject({
      artifactId,
      number: 1,
      kind: "html",
      title: "Landing page",
      content: "<h1>Hi</h1>",
    });
  });

  it("refuses another user, a version that doesn't exist, and an unknown Artifact", async () => {
    const { deps, artifactId } = await savedArtifact();
    const stranger = await insertUser();

    await expect(
      chatRpc({ user: stranger, deps }).artifact.version({ artifactId, number: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { user } = await savedArtifact();
    await expect(
      chatRpc({ user, deps }).artifact.version({ artifactId, number: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      chatRpc({ user, deps }).artifact.version({ artifactId, number: 2 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      chatRpc({ user, deps }).artifact.version({ artifactId: "missing", number: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not exist while Artifacts are off", async () => {
    const { user, deps, artifactId } = await savedArtifact();

    await expect(
      chatRpc({ user, deps: { ...deps, artifacts: false } }).artifact.version({
        artifactId,
        number: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
