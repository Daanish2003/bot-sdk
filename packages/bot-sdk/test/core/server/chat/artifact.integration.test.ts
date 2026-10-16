import { storedParts } from "../../../../plugins/assistant/shared/message-parts";
import { artifact, artifactVersion, message } from "../../../../core/server/db/schema";
import {
  createArtifactTool,
  cutOffArtifactResult,
  updateArtifactTool,
} from "../../../../plugins/assistant/server/chat/artifact-tool";
import {
  createPartsBuilder,
  parseStoredParts,
} from "../../../../plugins/assistant/shared/chat/parts";
import { createToolBudget } from "../../../../plugins/assistant/server/chat/tracked-tool";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { toolDefinition } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { curatedModels } from "../../../../core/shared/chat/models";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestSdk, type TestDepsOverrides, type TestDeps } from "../../../support/deps";
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
  const deps = createTestSdk({ adapterFor: () => fake.adapter, artifacts, ...overrides });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  // Titled, so a complete run doesn't call the adapter again to title it (#26).
  const conv = await insertConversation(user, { title: "Artifacts" });
  const send = (
    command: { text?: string; model?: string; parentId?: string | null } = {},
    runDeps: TestDeps = deps,
  ) =>
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
      runDeps,
    );
  return { user, deps, fake, conv, send };
}

/** The Model's answer to each tool call, as the next round of the Model received it. */
const toolResult = (fake: ReturnType<typeof createFakeAdapter>, round: number) =>
  fake.calls[round]!.messages.at(-1);

async function repliesOf(deps: TestDeps, conversationId: string) {
  const rows = await deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.filter((row) => row.role === "assistant");
}

const replyOf = async (deps: TestDeps, conversationId: string) =>
  (await repliesOf(deps, conversationId)).at(-1)!;

/**
 * The database, with `onArtifactInsert` run as each row of `watched` (an `artifact` row by default)
 * is inserted, inside its transaction. A throw there fails the write, and the transaction rolls back.
 */
function withArtifactInsertHook(
  db: TestDeps["db"],
  onArtifactInsert: () => void,
  watched: unknown = artifact,
): TestDeps["db"] {
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== "transaction") return Reflect.get(target, key, receiver);
      return (work: (tx: unknown) => Promise<unknown>) =>
        target.transaction((tx) =>
          work(
            new Proxy(tx as object, {
              get(inner, field, self) {
                if (field !== "insert") return Reflect.get(inner, field, self);
                return (table: unknown) => {
                  if (table === watched) onArtifactInsert();
                  return (inner as { insert: (t: unknown) => unknown }).insert(table);
                };
              },
            }),
          ),
        );
    },
  }) as TestDeps["db"];
}

const artifactRowsOf = (deps: TestDeps, conversationId: string) =>
  deps.db.select().from(artifact).where(eq(artifact.conversationId, conversationId));

const versionRowsOf = (deps: TestDeps) => deps.db.select().from(artifactVersion);

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
          type: "tool_call",
          toolCallId: "call-1",
          name: "create_artifact",
          source: "builtin",
          args: { kind: "html", title: "Landing page" },
          state: "done",
          result: { artifactId: row!.id, version: 1 },
        },
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
    // The Stop lands as the artifact row is written, before its version: the transaction rolls back.
    const controller = new AbortController();
    const db = withArtifactInsertHook(deps.db, () => controller.abort());
    const parts = createPartsBuilder();
    const tool = createArtifactTool({
      deps: { ...deps, db },
      messageId: reply.id,
      conversationId: conv.id,
      parts,
      onChange: () => {},
      budget: createToolBudget(0),
    });

    await expect(
      tool.execute!(htmlPage, { toolCallId: "call-1", abortSignal: controller.signal } as never),
    ).rejects.toThrow("stopped");
    expect(await artifactRowsOf(deps, conv.id)).toEqual([]);
    expect(await versionRowsOf(deps)).toEqual([]);
    // The cut call stays running in the reply, for the Run to close as cancelled.
    expect(parts.parts().parts).toEqual([
      expect.objectContaining({ type: "tool_call", state: "running" }),
    ]);
  });

  it("answers a write that fails with an error result, and keeps the failed call in the reply", async () => {
    const { deps, conv, send } = await setup({ rounds: [round(text("Done."))] });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);
    const db = new Proxy(deps.db, {
      get(target, key, receiver) {
        if (key !== "transaction") return Reflect.get(target, key, receiver);
        return () => Promise.reject(new Error("The database is down"));
      },
    });
    const parts = createPartsBuilder();
    const tool = createArtifactTool({
      deps: { ...deps, db },
      messageId: reply.id,
      conversationId: conv.id,
      parts,
      onChange: () => {},
      budget: createToolBudget(0),
    });

    const result = await tool.execute!(htmlPage, { toolCallId: "call-1" } as never);

    expect(result).toEqual({ error: "The database is down" });
    expect(await artifactRowsOf(deps, conv.id)).toEqual([]);
    expect(parts.parts().parts).toEqual([
      {
        type: "tool_call",
        toolCallId: "call-1",
        name: "create_artifact",
        source: "builtin",
        args: { kind: "html", title: "Landing page" },
        state: "error",
        result: { error: "The database is down" },
      },
    ]);
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

  it("counts a failed Artifact call against the budget, and reloads it as a failed card", async () => {
    const calls = Array.from({ length: 11 }, (_, i) =>
      createCall(`call-${i + 1}`, { ...htmlPage, title: `Page ${i + 1}` }),
    );
    const { deps, fake, conv, send } = await setup({
      rounds: [round(...calls), round(text("Done."))],
    });
    // The first artifact write fails inside its transaction; the others go through.
    let failed = false;
    const db = withArtifactInsertHook(deps.db, () => {
      if (failed) return;
      failed = true;
      throw new Error("The database is down");
    });

    await (await send({}, { ...deps, db })).text();

    expect(await artifactRowsOf(deps, conv.id)).toHaveLength(9);
    expect(
      fake.calls[1]!.messages.find((m) => m.role === "tool" && m.toolCallId === "call-11"),
    ).toMatchObject({ content: JSON.stringify({ error: "tool call limit reached" }) });
    // The round's calls run together, so any one of them may be the write that failed.
    const { parts } = parseStoredParts((await replyOf(deps, conv.id)).parts);
    const failedWrites = parts.filter(
      (part) =>
        part.type === "tool_call" &&
        part.state === "error" &&
        (part.result as { error?: string } | undefined)?.error === "The database is down",
    );
    expect(failedWrites).toEqual([
      expect.objectContaining({ name: "create_artifact", source: "builtin" }),
    ]);
    expect(parts.filter((part) => part.type === "artifact")).toHaveLength(9);
  });

  it("stops a Run mid-write through the Stop path: nothing is saved, and the call ends cancelled", async () => {
    const { user, deps, conv, send } = await setup({
      rounds: [round(createCall("call-1", htmlPage)), round(text("Never."))],
    });
    // The Stop is sent through the same stop RPC as a user's, once the reply exists and before the
    // Artifact's transaction runs; its signal is aborted by the time the artifact row is written.
    let stopped = false;
    const db = new Proxy(deps.db, {
      get(target, key, receiver) {
        if (key !== "transaction") return Reflect.get(target, key, receiver);
        return async (...args: Parameters<typeof target.transaction>) => {
          const reply = stopped ? undefined : await replyOf(deps, conv.id);
          if (reply) {
            stopped = true;
            await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return target.transaction(...args);
        };
      },
    }) as TestDeps["db"];

    await (await send({}, { ...deps, db })).text();

    expect(await artifactRowsOf(deps, conv.id)).toEqual([]);
    expect(await versionRowsOf(deps)).toEqual([]);
    const reply = await replyOf(deps, conv.id);
    expect(reply).toMatchObject({ status: "stopped" });
    const { parts } = parseStoredParts(reply.parts);
    expect(parts).toContainEqual({
      type: "tool_call",
      toolCallId: "call-1",
      name: "create_artifact",
      source: "builtin",
      args: { kind: "html", title: "Landing page" },
      state: "cancelled",
    });
    expect(parts.some((part) => part.type === "artifact")).toBe(false);
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
    return { user, deps, artifactId: row!.id, messageId: (await replyOf(deps, conv.id)).id };
  }

  it("returns the version's content to the owner of its Conversation", async () => {
    const { user, deps, artifactId, messageId } = await savedArtifact();

    const version = await chatRpc({ user, deps }).artifact.version({
      artifactId,
      number: 1,
      messageId,
    });

    expect(version).toMatchObject({
      artifactId,
      number: 1,
      kind: "html",
      title: "Landing page",
      content: "<h1>Hi</h1>",
    });
  });

  it("refuses another user, a version that doesn't exist, and an unknown Artifact", async () => {
    const { deps, artifactId, messageId } = await savedArtifact();
    const stranger = await insertUser();

    await expect(
      chatRpc({ user: stranger, deps }).artifact.version({ artifactId, number: 1, messageId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { user } = await savedArtifact();
    await expect(
      chatRpc({ user, deps }).artifact.version({ artifactId, number: 1, messageId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      chatRpc({ user, deps }).artifact.version({ artifactId, number: 2, messageId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      chatRpc({ user, deps }).artifact.version({ artifactId: "missing", number: 1, messageId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not exist while Artifacts are off", async () => {
    const { user, artifactId, messageId } = await savedArtifact();

    await expect(
      chatRpc({ user, deps: createTestSdk({ artifacts: false }) }).artifact.version({
        artifactId,
        number: 1,
        messageId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
describe("update_artifact in a reply", () => {
  const page = {
    kind: "html" as const,
    title: "Landing page",
    content: "<h1>Hi</h1>\n<button>Go</button>",
  };
  const updateCall = (id: string, input: Record<string, unknown>) =>
    toolCall({ id, name: "update_artifact", input });
  const versionsOf = (deps: TestDeps, artifactId: string) =>
    deps.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, artifactId))
      .orderBy(asc(artifactVersion.number));
  const onlyArtifactId = async (deps: TestDeps, conversationId: string) =>
    (await artifactRowsOf(deps, conversationId))[0]!.id;
  /** The Active Branch's last reply, which the next send continues from. */
  const tip = (deps: TestDeps, conversationId: string) => replyOf(deps, conversationId);

  it("makes v2 by edits, with the full edited content, and says it was saved as v2", async () => {
    let artifactId = "";
    const { deps, fake, conv, send } = await setup({
      rounds: [
        round(createCall("call-1", page)),
        round(text("Made it.")),
        () =>
          round(
            updateCall("call-2", {
              artifactId,
              edits: [{ old: "<button>Go</button>", new: '<button class="blue">Go</button>' }],
            }),
          ),
        round(text("Blue.")),
      ],
    });
    await (await send()).text();
    artifactId = await onlyArtifactId(deps, conv.id);

    await (
      await send({ text: "Make the button blue", parentId: (await tip(deps, conv.id)).id })
    ).text();

    const reply = await tip(deps, conv.id);
    expect(await versionsOf(deps, artifactId)).toEqual([
      expect.objectContaining({ number: 1, content: page.content }),
      expect.objectContaining({
        number: 2,
        messageId: reply.id,
        title: "Landing page",
        content: '<h1>Hi</h1>\n<button class="blue">Go</button>',
      }),
    ]);
    expect(toolResult(fake, 3)).toMatchObject({
      role: "tool",
      toolCallId: "call-2",
      content: JSON.stringify({ artifactId, version: 2 }),
    });
    expect(reply.parts).toMatchObject({
      parts: expect.arrayContaining([
        expect.objectContaining({ type: "artifact", artifactId, version: 2, state: "done" }),
      ]),
    });
  });

  it("makes no version when an edit has no match or several, names the edit, and applies none", async () => {
    let artifactId = "";
    const { deps, fake, conv, send } = await setup({
      rounds: [
        round(createCall("call-1", page)),
        round(text("Made it.")),
        () =>
          round(
            updateCall("call-2", {
              artifactId,
              edits: [
                { old: "<h1>Hi</h1>", new: "<h1>Hello</h1>" },
                { old: "nowhere", new: "x" },
              ],
            }),
          ),
        round(text("Could not.")),
        () => round(updateCall("call-3", { artifactId, edits: [{ old: "<", new: "&lt;" }] })),
        round(text("Still not.")),
      ],
    });
    await (await send()).text();
    artifactId = await onlyArtifactId(deps, conv.id);

    await (await send({ text: "Change it", parentId: (await tip(deps, conv.id)).id })).text();
    expect(toolResult(fake, 3)).toMatchObject({
      toolCallId: "call-2",
      content: JSON.stringify({ error: "Edit 2: No match" }),
    });

    await (await send({ text: "Escape it", parentId: (await tip(deps, conv.id)).id })).text();
    expect(toolResult(fake, 5)).toMatchObject({
      toolCallId: "call-3",
      content: JSON.stringify({ error: "Edit 1: Found 4 matches" }),
    });
    expect(await versionsOf(deps, artifactId)).toHaveLength(1);
  });

  it("makes v2 by a full content rewrite, and v3 by restoring v1, each keeping the title", async () => {
    let artifactId = "";
    const { deps, conv, send } = await setup({
      rounds: [
        round(createCall("call-1", page)),
        round(text("Made it.")),
        () => round(updateCall("call-2", { artifactId, content: "<h1>Rewritten</h1>" })),
        round(text("Rewritten.")),
        () => round(updateCall("call-3", { artifactId, restoreVersion: 1 })),
        round(text("Restored.")),
      ],
    });
    await (await send()).text();
    artifactId = await onlyArtifactId(deps, conv.id);

    await (await send({ text: "Rewrite it", parentId: (await tip(deps, conv.id)).id })).text();
    await (await send({ text: "Undo it", parentId: (await tip(deps, conv.id)).id })).text();

    expect(await versionsOf(deps, artifactId)).toEqual([
      expect.objectContaining({ number: 1, content: page.content }),
      expect.objectContaining({ number: 2, content: "<h1>Rewritten</h1>", title: "Landing page" }),
      expect.objectContaining({ number: 3, content: page.content, title: "Landing page" }),
    ]);
  });

  it("refuses a call with none, or two, of edits, content and restoreVersion, and stores nothing", async () => {
    let artifactId = "";
    const { deps, fake, conv, send } = await setup({
      rounds: [
        round(createCall("call-1", page)),
        round(text("Made it.")),
        () => round(updateCall("call-2", { artifactId })),
        round(text("No.")),
        () => round(updateCall("call-3", { artifactId, content: "x", restoreVersion: 1 })),
        round(text("No.")),
      ],
    });
    await (await send()).text();
    artifactId = await onlyArtifactId(deps, conv.id);

    await (await send({ text: "Nothing", parentId: (await tip(deps, conv.id)).id })).text();
    await (await send({ text: "Two", parentId: (await tip(deps, conv.id)).id })).text();

    for (const index of [3, 5]) {
      expect(String(toolResult(fake, index)?.content)).toContain("exactly one of edits");
    }
    expect(await versionsOf(deps, artifactId)).toHaveLength(1);
  });

  it("gives each sibling Branch its own v2, and the version read resolves it on the Branch asked", async () => {
    let artifactId = "";
    const { user, deps, fake, conv, send } = await setup({
      rounds: [
        round(createCall("call-1", page)),
        round(text("Made it.")),
        () =>
          round(
            updateCall("call-2", {
              artifactId,
              edits: [{ old: "<h1>Hi</h1>", new: "<h1>Blue</h1>" }],
            }),
          ),
        round(text("Blue.")),
        () =>
          round(
            updateCall("call-3", {
              artifactId,
              edits: [{ old: "<h1>Hi</h1>", new: "<h1>Big</h1>" }],
            }),
          ),
        round(text("Big.")),
      ],
    });
    await (await send()).text();
    artifactId = await onlyArtifactId(deps, conv.id);
    const first = await tip(deps, conv.id);

    // Two sends from the same reply: the second edits the first, so its Branch skips the version
    // the first Branch made.
    await (await send({ text: "Make it blue", parentId: first.id })).text();
    const blueReply = await tip(deps, conv.id);
    await (await send({ text: "Make it big", parentId: first.id })).text();
    const bigReply = await tip(deps, conv.id);

    expect(toolResult(fake, 3)).toMatchObject({
      toolCallId: "call-2",
      content: JSON.stringify({ artifactId, version: 2 }),
    });
    expect(toolResult(fake, 5)).toMatchObject({
      toolCallId: "call-3",
      content: JSON.stringify({ artifactId, version: 2 }),
    });
    const twos = (await versionsOf(deps, artifactId)).filter((row) => row.number === 2);
    expect(twos.map((row) => [row.messageId, row.content]).sort()).toEqual(
      [
        [blueReply.id, "<h1>Blue</h1>\n<button>Go</button>"],
        [bigReply.id, "<h1>Big</h1>\n<button>Go</button>"],
      ].sort(),
    );

    const onBlue = await chatRpc({ user, deps }).artifact.version({
      artifactId,
      number: 2,
      messageId: blueReply.id,
    });
    const onBig = await chatRpc({ user, deps }).artifact.version({
      artifactId,
      number: 2,
      messageId: bigReply.id,
    });
    expect(onBlue.content).toContain("Blue");
    expect(onBig.content).toContain("Big");
  });

  it("answers an update of an Artifact that is not on this Branch with an error, and stores nothing", async () => {
    let artifactId = "";
    const { deps, fake, conv, send } = await setup({
      rounds: [
        round(createCall("call-1", page)),
        round(text("Made it.")),
        () => round(updateCall("call-2", { artifactId, content: "<h1>Elsewhere</h1>" })),
        round(text("Could not.")),
      ],
    });
    await (await send()).text();
    artifactId = await onlyArtifactId(deps, conv.id);

    // A new root Message: a Branch that doesn't go through the reply that made the Artifact.
    await (await send({ text: "Something else", parentId: null })).text();

    expect(toolResult(fake, 3)).toMatchObject({
      toolCallId: "call-2",
      content: JSON.stringify({ error: "This Artifact isn't on this Branch" }),
    });
    expect(await versionsOf(deps, artifactId)).toHaveLength(1);
  });

  it("makes a new Artifact when the reply that created one is regenerated", async () => {
    const { deps, conv, send } = await setup({
      rounds: [
        round(createCall("call-1", page)),
        round(text("Made it.")),
        round(createCall("call-2", page)),
        round(text("Made it again.")),
      ],
    });
    await (await send()).text();
    const first = await tip(deps, conv.id);

    await (await send({ text: undefined, parentId: first.parentId })).text();

    const ids = (await artifactRowsOf(deps, conv.id)).map((row) => row.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("stores an update made in a Run resumed after an Approval like any other", async () => {
    let artifactId = "";
    const { user, deps, conv, send } = await setup({
      rounds: [
        round(createCall("call-1", page)),
        round(toolCall({ id: "call-mail", name: "send_mail", input: { to: "a@b.c" } })),
        () =>
          round(
            updateCall("call-2", {
              artifactId,
              edits: [{ old: "<h1>Hi</h1>", new: "<h1>Approved</h1>" }],
            }),
          ),
        round(text("Done.")),
      ],
      deps: {
        tools: [
          toolDefinition({
            name: "send_mail",
            description: "Sends an email.",
            inputSchema: z.object({ to: z.string() }),
            needsApproval: true,
          }).server(async () => ({ sent: true })),
        ],
      },
    });
    await (await send()).text();
    artifactId = await onlyArtifactId(deps, conv.id);
    const reply = await tip(deps, conv.id);

    await chatRpc({ user, deps }).chat.decide({ messageId: reply.id, approved: true });
    await (
      await sendAs(
        new Request(`http://localhost/api/chat/run?runId=${reply.id}`, { method: "GET" }),
        user,
        deps,
      )
    ).text();

    expect(await versionsOf(deps, artifactId)).toEqual([
      expect.objectContaining({ number: 1 }),
      expect.objectContaining({
        number: 2,
        messageId: reply.id,
        content: "<h1>Approved</h1>\n<button>Go</button>",
      }),
    ]);
  });

  it("stops mid-write: the version is not saved, and the call stays running for the Run to cancel", async () => {
    let artifactId = "";
    const { deps, conv, send } = await setup({
      rounds: [round(createCall("call-1", page)), round(text("Made it."))],
    });
    await (await send()).text();
    artifactId = await onlyArtifactId(deps, conv.id);
    const reply = await tip(deps, conv.id);
    // The Stop lands as the version is written, before it commits: the transaction rolls back.
    const controller = new AbortController();
    const db = withArtifactInsertHook(deps.db, () => controller.abort(), artifactVersion);
    const parts = createPartsBuilder();
    const tool = updateArtifactTool({
      deps: { ...deps, db },
      messageId: reply.id,
      conversationId: conv.id,
      parts,
      onChange: () => {},
      budget: createToolBudget(0),
    });

    await expect(
      tool.execute!({ artifactId, content: "<h1>Stopped</h1>" }, {
        toolCallId: "call-2",
        abortSignal: controller.signal,
      } as never),
    ).rejects.toThrow("stopped");
    expect(await versionsOf(deps, artifactId)).toHaveLength(1);
    expect(parts.parts().parts).toEqual([
      expect.objectContaining({ type: "tool_call", name: "update_artifact", state: "running" }),
    ]);
  });
});

describe("what the Model sees of Artifacts (ADR 0016)", () => {
  const page = {
    kind: "html" as const,
    title: "Landing page",
    content: "<h1>Hi</h1>\n<button>Go</button>",
  };
  const updateCall = (id: string, input: Record<string, unknown>) =>
    toolCall({ id, name: "update_artifact", input });

  it("replays the Artifact calls as stubs, and sends the latest content once, after the system prompts", async () => {
    let artifactId = "";
    const { deps, fake, conv, send } = await setup({
      rounds: [
        round(createCall("call-1", page)),
        round(text("Made it.")),
        () =>
          round(
            updateCall("call-2", {
              artifactId,
              edits: [{ old: "<button>Go</button>", new: '<button class="blue">Go</button>' }],
            }),
          ),
        round(text("Blue.")),
        round(text("Next.")),
      ],
    });
    await (await send()).text();
    artifactId = (await artifactRowsOf(deps, conv.id))[0]!.id;
    await (
      await send({ text: "Make the button blue", parentId: (await replyOf(deps, conv.id)).id })
    ).text();
    await (await send({ text: "What next?", parentId: (await replyOf(deps, conv.id)).id })).text();

    const next = fake.calls[4]!;
    expect(next.messages).toEqual([
      { role: "user", content: "Make me a page" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "create_artifact",
              arguments: JSON.stringify({ kind: "html", title: "Landing page" }),
            },
          },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: JSON.stringify("saved as v1") },
      { role: "assistant", content: "Made it." },
      { role: "user", content: "Make the button blue" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-2",
            type: "function",
            function: { name: "update_artifact", arguments: JSON.stringify({ artifactId }) },
          },
        ],
      },
      { role: "tool", toolCallId: "call-2", content: JSON.stringify("saved as v2") },
      { role: "assistant", content: "Blue." },
      { role: "user", content: "What next?" },
    ]);
    expect(next.systemPrompts).toHaveLength(1);
    const latest = String(next.systemPrompts![0]);
    expect(latest.split("<artifact ").length - 1).toBe(1);
    expect(latest).toContain(`id="${artifactId}"`);
    expect(latest).toContain('version="2"');
    expect(latest).toContain('<button class="blue">Go</button>');
    expect(latest).not.toContain("<button>Go</button>");
  });

  it("sends the latest version of each Artifact on the path, and not one written on another Branch", async () => {
    const { deps, fake, conv, send } = await setup({
      rounds: [
        round(createCall("call-1", { kind: "markdown", title: "Notes", content: "# Notes" })),
        round(text("Notes made.")),
        round(createCall("call-2", { kind: "svg", title: "Logo", content: "<svg></svg>" })),
        round(text("Logo made.")),
        round(
          createCall("call-3", {
            kind: "code",
            title: "Other Branch",
            language: "python",
            content: "print(1)",
          }),
        ),
        round(text("Other made.")),
        round(text("Final.")),
      ],
    });
    await (await send()).text();
    const first = await replyOf(deps, conv.id);
    await (await send({ text: "A logo", parentId: first.id })).text();
    const second = await replyOf(deps, conv.id);
    await (await send({ text: "A sibling", parentId: first.id })).text();
    await (await send({ text: "Continue", parentId: second.id })).text();

    const prompt = fake.calls[6]!.systemPrompts!.join("\n");
    expect(prompt).toContain('title="Notes"');
    expect(prompt).toContain('title="Logo"');
    expect(prompt).not.toContain("Other Branch");
    expect(prompt).not.toContain("print(1)");
  });

  it("still sends the latest content after compaction has dropped the Message that made it", async () => {
    const { deps, fake, conv, send, user } = await setup({
      rounds: [round(createCall("call-1", page)), round(text("Made it.")), round(text("Ok."))],
    });
    // Nova Pro's budget is 288,000 tokens; four Messages of ~100,000 tokens each don't fit beside it.
    const novaPro = "bedrock:us.amazon.nova-pro-v1:0";
    await saveCredentials(deps, user.id, {
      service: "bedrock",
      fields: { apiKey: "test-key" },
      hint: "…-key",
      verified: true,
    });
    await (await send({ model: novaPro })).text();
    let parentId = (await replyOf(deps, conv.id)).id;
    for (let index = 0; index < 4; index++) {
      const row = await insertMessage({
        conversationId: conv.id,
        parentId,
        role: index % 2 === 0 ? "user" : "assistant",
        text: `m${index} ${"x".repeat(400_000)}`,
      });
      parentId = row.id;
    }
    await (await send({ text: "What now?", parentId, model: novaPro })).text();

    const compacted = fake.calls[2]!;
    expect(JSON.stringify(compacted.messages)).not.toContain("m0 ");
    expect(JSON.stringify(compacted.messages)).not.toContain("saved as v1");
    expect(compacted.systemPrompts!.join("\n")).toContain("<h1>Hi</h1>");
  });

  it("answers a create cut off mid-arguments with a short error, with no partial content, and saves nothing", async () => {
    const { deps, fake, conv, send } = await setup({
      rounds: [
        round(
          toolCall({
            id: "call-cut",
            name: "create_artifact",
            input: undefined,
            raw: '{"kind":"html","title":"Big","content":"<h1>PARTIAL-CONTENT',
          }),
        ),
        round(text("Sorry, that was cut off.")),
      ],
    });

    await (await send()).text();

    expect(await artifactRowsOf(deps, conv.id)).toEqual([]);
    expect(await versionRowsOf(deps)).toEqual([]);
    expect(JSON.stringify(fake.calls[1]!.messages)).not.toContain("PARTIAL-CONTENT");
    expect(fake.calls[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-cut",
      content: JSON.stringify(cutOffArtifactResult),
    });
  });

  it("sends a Conversation with no Artifact as before: no Artifact prompt, and its text as is", async () => {
    const { deps, fake, conv, send } = await setup({
      rounds: [round(text("Hello.")), round(text("Again."))],
    });

    await (await send()).text();
    await (await send({ text: "More", parentId: (await replyOf(deps, conv.id)).id })).text();

    expect(fake.calls[0]!.systemPrompts ?? []).toEqual([]);
    expect(fake.calls[1]!.systemPrompts ?? []).toEqual([]);
    expect(fake.calls[1]!.messages).toEqual([
      { role: "user", content: "Make me a page" },
      { role: "assistant", content: "Hello." },
      { role: "user", content: "More" },
    ]);
  });
});
