import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { createBotSdk } from "../../../core/server/create-chat";
import { bot } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { exportUserData } from "../../../core/server/user-data";
import type { BotExport } from "../../../plugins/bot/server/store";
import { saveSecret } from "../../../plugins/bot/server/secret";
import { saveTokens } from "../../../plugins/mcp/server/connections";
import { mcp } from "../../../plugins/mcp/server/plugin";
import {
  logPath,
  notesPath,
  profilePath,
  type ExportedBotMemory,
} from "../../../plugins/memory/server/bot-memory";
import { memorySettings } from "../../../plugins/memory/server/schema";
import { memory } from "../../../plugins/memory/server/feature";
import { saveCredentials } from "../../../plugins/models/server/credentials/store";
import { fakeComputerProvider } from "../../plugins/computer/server/fake-provider";
import { botOf, botSdk, stopBotRunners } from "../../support/bot-turns";
import { insertConversation } from "../../support/conversations";
import { createTestSdk } from "../../support/deps";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { insertUser, type TestUser } from "../../support/users";

const testKey = "test-key-encryption-secret-not-for-production";
const providerKey = "sk-ant-secret-never-exported";
const toolKey = "tvly-secret-never-exported";
const secretValue = "ghp-secret-value-never-exported";
const accessToken = "linear-token-never-exported";

afterEach(stopBotRunners);

/** The Host's SDK with every Bot-only plugin that exports a part of a user's data. */
function chatFor() {
  return createBotSdk({
    databaseUrl: testDatabaseUrl,
    getUser: () => null,
    keyEncryptionSecrets: [testKey],
    basePath: "/api/chat",
    computer: fakeComputerProvider().provider,
    models: {},
    features: [memory(), mcp()],
  });
}

describe("createBotSdk().exportUser, with Bots", () => {
  it("has the format version and each installed plugin's part, and only the user's Bots", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    await insertBot(owner, "Ada", new Date("2026-10-01T10:00:00Z"));
    await insertBot(other, "Bea", new Date("2026-10-02T10:00:00Z"));

    const document = await chatFor().exportUser(owner.id);

    expect(document.version).toBe(2);
    expect(document.exportedAt).toBeInstanceOf(Date);
    expect((document.bot as BotExport).bots).toEqual([
      expect.objectContaining({ name: "Ada", model: "anthropic:claude-sonnet-5-5", messages: [] }),
    ]);
    expect(document.memory).toEqual({ memoryEnabled: true, botMemory: [] });
    expect(document.models).toEqual({ imageModel: null });
    expect(document).not.toHaveProperty("assistant");
  });

  it("never includes the Provider or Tool keys, a Secret's value or a Connection's tokens", async () => {
    const owner = await insertUser();
    const { deps } = await botSdk({ features: [mcp()] }, { idle: true });
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
    const { botId } = await botOf(deps, owner, "anthropic:claude-sonnet-5-5");
    await saveSecret(deps, owner.id, { botId, name: "GITHUB_TOKEN", value: secretValue });
    await saveTokens(deps, owner.id, "linear", { accessToken, tokenType: "Bearer", scope: "" });

    const document = await chatFor().exportUser(owner.id);

    const text = JSON.stringify(document);
    // Positive control: the Bot those were saved for is in it.
    expect(text).toContain(botId);
    expect(text).not.toContain(providerKey);
    expect(text).not.toContain(toolKey);
    expect(text).not.toContain(secretValue);
    expect(text).not.toContain(accessToken);
  });

  it("exports an empty document for an unknown user id", async () => {
    const document = await chatFor().exportUser(randomUUID());

    expect(document).toMatchObject({
      version: 2,
      bot: { bots: [] },
      memory: { memoryEnabled: true, botMemory: [] },
    });
  });

  it("holds the user's Memory switch in the memory plugin's part", async () => {
    const owner = await insertUser();
    await getTestDb().insert(memorySettings).values({ userId: owner.id, enabled: false });

    const document = await chatFor().exportUser(owner.id);

    expect(document.memory).toEqual({ memoryEnabled: false, botMemory: [] });
  });
});

/** A Bot of `owner`, made at `createdAt`, with its own Conversation as the `bot` plugin makes it. */
async function insertBot(owner: TestUser, name: string, createdAt: Date): Promise<string> {
  const conversation = await insertConversation(owner, { kind: "bot" });
  const id = uuidv7();
  await getTestDb().insert(bot).values({
    id,
    userId: owner.id,
    conversationId: conversation.id,
    name,
    model: "anthropic:claude-sonnet-5-5",
    createdAt,
  });
  return id;
}

describe("exportUser, Bot memory", () => {
  it("holds each Bot's profile, its Log months and its notes as the Computer has them", async () => {
    const fake = fakeComputerProvider();
    const deps = createTestSdk({ computer: fake.provider });
    const owner = await insertUser();
    const ada = await insertBot(owner, "Ada", new Date("2026-10-01T10:00:00Z"));
    const bea = await insertBot(owner, "Bea", new Date("2026-10-02T10:00:00Z"));
    // Creates the user's Computer, so its disk is the one the files go on.
    await deps.computer!.forUser(owner.id).run("true");
    const text = (content: string) => new TextEncoder().encode(content);
    fake.files.set(profilePath(ada), text("- Prefers short replies\n"));
    fake.files.set(notesPath(ada), text("- 2026-10-20 Waiting on the landlord\n"));
    fake.files.set(logPath(ada, "2026-10"), text("- 2026-10-03 (importance 7) Moved to Berlin\n"));
    fake.files.set(logPath(ada, "2026-09"), text("- 2026-09-02 (importance 6) Started a job\n"));

    const exported = (await exportUserData(deps, owner.id)).memory as {
      botMemory: ExportedBotMemory[];
    };

    expect(exported.botMemory).toEqual([
      {
        botId: ada,
        profile: "- Prefers short replies\n",
        notes: "- 2026-10-20 Waiting on the landlord\n",
        log: [
          { month: "2026-09", text: "- 2026-09-02 (importance 6) Started a job\n" },
          { month: "2026-10", text: "- 2026-10-03 (importance 7) Moved to Berlin\n" },
        ],
      },
      { botId: bea, profile: "", notes: "", log: [] },
    ]);
  });

  it("leaves out a Bot whose files the Computer fails to read, and keeps the rest", async () => {
    const fake = fakeComputerProvider();
    const deps = createTestSdk({ computer: fake.provider });
    const owner = await insertUser();
    const ada = await insertBot(owner, "Ada", new Date("2026-10-01T10:00:00Z"));
    const bea = await insertBot(owner, "Bea", new Date("2026-10-02T10:00:00Z"));
    await deps.computer!.forUser(owner.id).run("true");
    // Ada's profile.md is a directory, so reading it fails.
    fake.files.set(`${profilePath(ada)}/stray.md`, new TextEncoder().encode("x"));
    fake.files.set(profilePath(bea), new TextEncoder().encode("- Works at a bakery\n"));

    const exported = (await exportUserData(deps, owner.id)).memory as {
      botMemory: ExportedBotMemory[];
    };

    expect(exported.botMemory).toEqual([
      { botId: bea, profile: "- Works at a bakery\n", notes: "", log: [] },
    ]);
  });

  it("exports the rest, with no Bot memory, when the Computer can't be woken", async () => {
    const fake = fakeComputerProvider();
    const deps = createTestSdk({ computer: fake.provider });
    const owner = await insertUser();
    await insertBot(owner, "Ada", new Date("2026-10-01T10:00:00Z"));
    await deps.computer!.forUser(owner.id).run("true");
    fake.lose(fake.callsOf("create")[0]!.sandboxId);
    fake.failing.add("create");

    const exported = (await exportUserData(deps, owner.id)).memory as {
      botMemory: ExportedBotMemory[];
    };

    expect(exported.botMemory).toEqual([]);
  });

  it("reads nothing and creates no Computer for a user who has none", async () => {
    const fake = fakeComputerProvider();
    const deps = createTestSdk({ computer: fake.provider });
    const owner = await insertUser();
    await insertBot(owner, "Ada", new Date("2026-10-01T10:00:00Z"));

    const exported = (await exportUserData(deps, owner.id)).memory as {
      botMemory: ExportedBotMemory[];
    };

    expect(exported.botMemory).toEqual([]);
    expect(fake.callsOf("create")).toEqual([]);
  });
});
