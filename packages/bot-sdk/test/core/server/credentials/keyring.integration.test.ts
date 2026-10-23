import { describe, expect, it, vi } from "vitest";

import { createBotSdk } from "../../../../core/server/create-chat";
import { bot } from "../../../../plugins/bot/server/plugin";
import { runner } from "../../../../plugins/runner/server/plugin";
import { models } from "../../../../plugins/models/server/plugin";
import { resolvedServices } from "../../../../plugins/models/server/credentials/resolve";
import {
  listCredentials,
  loadCredentials,
  saveCredentials,
} from "../../../../plugins/models/server/credentials/store";
import { createTestSdk } from "../../../support/deps";
import { userCredentials } from "../../../../core/server/db/schema";
import { insertUser } from "../../../support/users";
import { getTestDb, testDatabaseUrl } from "../../../support/test-database";

const keyA = "key-a-of-at-least-32-characters-long!!";
const keyB = "key-b-of-at-least-32-characters-long!!";
const fields = { apiKey: "sk-proj-abcd" };
const summary = { hint: "…abcd", verified: true };

describe("the keyring", () => {
  it("reads a credential saved under an older key of the keyring", async () => {
    const user = await insertUser();
    await saveCredentials(createTestSdk({ keyEncryptionSecrets: [keyA] }), user.id, {
      service: "openai",
      fields,
      ...summary,
    });
    const keyring = createTestSdk({ keyEncryptionSecrets: [keyB, keyA] });

    await expect(loadCredentials(keyring, user.id, "openai")).resolves.toEqual(fields);
    await expect(resolvedServices(keyring, user.id)).resolves.toEqual(["openai"]);
  });

  it("reads a credential under a removed key as missing and not listed", async () => {
    const user = await insertUser();
    await saveCredentials(createTestSdk({ keyEncryptionSecrets: [keyA] }), user.id, {
      service: "openai",
      fields,
      ...summary,
    });
    const keyring = createTestSdk({ keyEncryptionSecrets: [keyB] });

    await expect(loadCredentials(keyring, user.id, "openai")).resolves.toBeNull();
    await expect(listCredentials(keyring, user.id)).resolves.toEqual([]);
  });

  it("counts unreadable rows by kind of failure at start, and still boots", async () => {
    const user = await insertUser();
    const keyring = createTestSdk({ keyEncryptionSecrets: [keyB] });
    await saveCredentials(createTestSdk({ keyEncryptionSecrets: [keyA] }), user.id, {
      service: "openai",
      fields,
      ...summary,
    });
    await saveCredentials(keyring, user.id, {
      service: "groq",
      fields,
      ...summary,
    });
    await getTestDb().insert(userCredentials).values({
      userId: user.id,
      service: "mistral",
      encrypted: "v2.corrupt",
      hint: "…",
      verified: true,
    });
    const logger = { error: vi.fn() };
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [keyB],
      basePath: "/api/chat",
      logger,
      plugins: [models(), runner(), bot()],
    });

    await chat.start();
    await chat.stop();

    expect(logger.error).toHaveBeenCalledWith(expect.any(String), {
      unknownKey: 1,
      corrupt: 1,
    });
  });
});
