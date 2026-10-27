import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import { createBotSdk } from "@botsdk/bot/create-chat";
import { featureApi } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { bot } from "@botsdk/bot/storage";
import { knowledge } from "@botsdk/knowledge";
import type { KnowledgeApi } from "@botsdk/knowledge/server/knowledge-api";
import { mcp } from "@botsdk/mcp";
import { memory } from "@botsdk/memory";
import type { MemoryApi } from "@botsdk/memory/server/memory-api";
import { skills } from "@botsdk/skills";
import type { SkillsApi } from "@botsdk/skills/server/skills-api";
import { fakeComputerProvider } from "../../support/fake-computer-provider";
import { insertConversation } from "../../support/conversations";
import { createTestSdk } from "../../support/deps";
import { createPinsTable, dropPinsTable, pin, pins } from "../../support/pins-feature";
import { chatRpc } from "../../support/sdk";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertOwner, insertUser, type TestUser } from "../../support/users";
import { postgres } from "@botsdk/bot/database";

/*
 * Each enabled feature's API is `sdk.<feature id>` (spec #873): Memory, Skills, Knowledge, MCP and
 * a feature written against `defineFeature` alone. A Host calls its methods in-process with a
 * `userId`; its procedures are one-line wrappers over the same methods.
 */

const testKey = "test-key-encryption-secret-not-for-production";

beforeAll(() => createPinsTable(getTestDb()));
afterAll(() => dropPinsTable(getTestDb()));

const options = {
  database: postgres({ connectionString: testDatabaseUrl }),
  keyEncryptionSecrets: [testKey],
  models: {},
};

async function insertBot(owner: TestUser): Promise<string> {
  const conversation = await insertConversation(owner, { kind: "bot" });
  const id = uuidv7();
  await getTestDb().insert(bot).values({
    id,
    userId: owner.id,
    conversationId: conversation.id,
    name: "Ada",
    model: "openai:gpt-6-luna",
  });
  return id;
}

const skillFile = (name: string) =>
  `---\nname: ${name}\ndescription: Use this when you need to ${name}\n---\n\n## Steps\n1. Do it.\n`;

describe("a feature's API as sdk.<feature id>", () => {
  it("exists only when the feature is enabled, and is typed", () => {
    const all = createBotSdk({
      ...options,
      computer: fakeComputerProvider().provider,
      features: [memory(), skills(), knowledge(), mcp(), pins()],
    });

    expectTypeOf(all.memory).toEqualTypeOf<MemoryApi>();
    expectTypeOf(all.skills).toEqualTypeOf<SkillsApi>();
    expectTypeOf(all.knowledge).toEqualTypeOf<KnowledgeApi>();
    expectTypeOf(all.mcp.listConnections).toBeFunction();
    expectTypeOf(all.pins.list).toBeFunction();
    for (const id of ["memory", "skills", "knowledge", "mcp", "pins"]) {
      expect(all).toHaveProperty(id);
    }

    const none = createBotSdk(options);
    for (const id of ["memory", "skills", "knowledge", "mcp", "pins"]) {
      expect(none).not.toHaveProperty(id);
    }
    // @ts-expect-error not enabled
    expect(none.memory).toBeUndefined();
  });

  it("serves the test-only feature's own namespace", async () => {
    const sdk = createBotSdk({
      ...options,
      computer: fakeComputerProvider().provider,
      features: [pins()],
    });
    const user = await insertUser();
    const botId = await insertBot(user);
    await getTestDb().insert(pin).values({
      id: "ns-pin",
      userId: user.id,
      botId,
      kind: "pin",
      text: "Buy milk",
    });

    expect(await sdk.pins.list({ userId: user.id })).toEqual(["Buy milk"]);
    expect(await sdk.pins.list({ userId: (await insertUser()).id })).toEqual([]);
  });
});

describe("Memory, Skills, Knowledge and MCP called in-process with a userId", () => {
  function setup() {
    // The Skills folder's removal is a shell command, answered on the fake disk.
    const computer = fakeComputerProvider({
      onCommand: ({ command }) => {
        const folder = /^rm -rf -- '(.*)'$/.exec(command)?.[1];
        for (const path of computer.files.keys()) {
          if (folder && path.startsWith(`${folder}/`)) computer.files.delete(path);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const deps = createTestSdk({
      computer: computer.provider,
      features: [skills(), knowledge(), mcp()],
    });
    return {
      memory: featureApi<MemoryApi>(deps, "memory"),
      skills: featureApi<SkillsApi>(deps, "skills"),
      knowledge: featureApi<KnowledgeApi>(deps, "knowledge"),
      mcp: featureApi<{
        listConnections: (input: { userId: string }) => Promise<unknown>;
      }>(deps, "mcp"),
      deps,
    };
  }

  it("memory works with a userId and returns what its HTTP twin returns", async () => {
    const { memory: api, deps } = setup();
    const user = await insertUser();
    const botId = await insertBot(user);
    const client = chatRpc({ user, deps });

    expect(await api.status({ userId: user.id })).toEqual(await client.memory.status());
    await api.botAddLine({ userId: user.id, botId, tier: "profile", text: "Likes tea" });
    const listed = await api.botList({ userId: user.id, botId });
    expect(listed).toEqual(await client.memory.botList({ botId }));
    expect(JSON.stringify(listed)).toContain("Likes tea");
    await api.setEnabled({ userId: user.id, enabled: false });
    expect(await api.isEnabled({ userId: user.id })).toBe(false);
    expect((await client.memory.status()).enabled).toBe(false);
  }, 30_000);

  it("memory refuses another user's Bot and invalid input", async () => {
    const { memory: api } = setup();
    const owner = await insertUser();
    const botId = await insertBot(owner);
    const stranger = await insertUser();

    await expect(api.botList({ userId: stranger.id, botId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      // @ts-expect-error `tier` is one of three
      api.botAddLine({ userId: owner.id, botId, tier: "nope", text: "x" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }, 30_000);

  it("skills works with a userId and returns what its HTTP twin returns", async () => {
    const { skills: api, deps } = setup();
    const user = await insertUser();
    const botId = await insertBot(user);
    const client = chatRpc({ user, deps });

    expect(api.status()).toEqual(await client.skills.status());
    expect(
      await api.save({
        userId: user.id,
        botId,
        name: "greet",
        content: skillFile("greet"),
        create: true,
      }),
    ).toEqual({ problem: null });
    const listed = await api.list({ userId: user.id, botId });
    expect(listed).toEqual(await client.skills.list({ botId }));
    expect(listed.map(({ name }) => name)).toEqual(["greet"]);
    expect(await api.read({ userId: user.id, botId, name: "greet" })).toEqual(
      await client.skills.read({ botId, name: "greet" }),
    );
    await api.remove({ userId: user.id, botId, name: "greet" });
    expect(await api.list({ userId: user.id, botId })).toEqual([]);
  }, 30_000);

  it("skills refuses another user's Bot", async () => {
    const { skills: api } = setup();
    const owner = await insertUser();
    const botId = await insertBot(owner);
    const stranger = await insertUser();

    await expect(api.list({ userId: stranger.id, botId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      api.save({ userId: stranger.id, botId, name: "x", content: skillFile("x") }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 30_000);

  it("knowledge works with a userId, per user, and returns what its HTTP twin returns", async () => {
    const { knowledge: api, deps } = setup();
    // Only a user with a Bot has a Computer.
    const user = await insertOwner();
    const other = await insertOwner();
    const client = chatRpc({ user, deps });

    expect(api.status()).toEqual(await client.knowledge.status());
    await api.upload({ userId: user.id, name: "a.md", content: "Hello" });
    expect(await api.read({ userId: user.id, path: "a.md" })).toEqual(
      await client.knowledge.read({ path: "a.md" }),
    );
    const listing = await api.list({ userId: user.id });
    expect(JSON.stringify(listing)).toContain("a.md");
    expect(JSON.stringify(await api.list({ userId: other.id }))).not.toContain("a.md");
    await api.remove({ userId: user.id, path: "a.md" });
    expect(JSON.stringify(await api.list({ userId: user.id }))).not.toContain("a.md");
  }, 30_000);

  it("mcp lists a user's Connections with no request", async () => {
    const { mcp: api, deps } = setup();
    const user = await insertUser();
    const client = chatRpc({ user, deps });

    expect(await api.listConnections({ userId: user.id })).toEqual(
      await client.mcp.listConnections(),
    );
  }, 30_000);
});
