import { describe, expect, it, vi } from "vitest";

import { createChat } from "../../../../core/server/create-chat";
import { encryptCredentials } from "../../../../core/server/credentials/encryption";
import {
  listCredentials,
  rotateCredentialKeys,
  saveCredentials,
} from "../../../../core/server/credentials/store";
import { userCredentials } from "../../../../core/server/db/schema/credentials";
import { createTestDeps } from "../../../support/deps";
import { insertUser } from "../../../support/users";
import { getTestDb, testDatabaseUrl } from "../../../support/test-database";

const keyA = "key-a-of-at-least-32-characters-long!!";
const keyB = "key-b-of-at-least-32-characters-long!!";
const fields = { apiKey: "sk-proj-abcd" };
const summary = { hint: "…abcd", verified: true };

describe("chat.rotateKeys()", () => {
  it("re-encrypts rows under the old key with the new one, and a second run changes nothing", async () => {
    const user = await insertUser();
    await saveCredentials(createTestDeps({ keyEncryptionSecrets: [keyA] }), user.id, {
      service: "openai",
      fields,
      ...summary,
    });
    await saveCredentials(createTestDeps({ keyEncryptionSecrets: [keyA] }), user.id, {
      service: "tavily",
      fields,
      ...summary,
    });
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [keyB, keyA],
      basePath: "/api/chat",
      logger: { error: vi.fn() },
    });

    await expect(chat.rotateKeys()).resolves.toEqual({ reencrypted: 2, unreadable: 0 });
    await expect(chat.rotateKeys()).resolves.toEqual({ reencrypted: 0, unreadable: 0 });

    // Only the new key is needed once the rows are rotated.
    const onlyNew = createTestDeps({ keyEncryptionSecrets: [keyB] });
    await expect(listCredentials(onlyNew, user.id)).resolves.toHaveLength(2);
  });

  it("re-encrypts every row when there are more rows than one batch", async () => {
    const user = await insertUser();
    const services = ["openai", "anthropic", "groq", "mistral", "tavily"];
    for (const service of services) {
      await saveCredentials(createTestDeps({ keyEncryptionSecrets: [keyA] }), user.id, {
        service,
        fields,
        ...summary,
      });
    }
    const deps = createTestDeps({ keyEncryptionSecrets: [keyB, keyA] });

    const result = await rotateCredentialKeys(deps, { batchSize: 2 });

    expect(result).toEqual({ reencrypted: 5, unreadable: { unknownKey: 0, corrupt: 0 } });
    await expect(
      listCredentials(createTestDeps({ keyEncryptionSecrets: [keyB] }), user.id),
    ).resolves.toHaveLength(5);
  });

  it("leaves a row no key can read in place, counts it, and logs it; unrotated rows read as missing once the old key is removed", async () => {
    const user = await insertUser();
    await saveCredentials(createTestDeps({ keyEncryptionSecrets: [keyA] }), user.id, {
      service: "openai",
      fields,
      ...summary,
    });
    await getTestDb()
      .insert(userCredentials)
      .values({
        userId: user.id,
        service: "mistral",
        encrypted: encryptCredentials(fields, {
          secrets: ["key-c-of-at-least-32-characters-long!!"],
          kind: "provider",
          context: `${user.id}:mistral`,
        }),
        hint: "…abcd",
        verified: true,
      });
    const logger = { error: vi.fn() };
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [keyB, keyA],
      basePath: "/api/chat",
      logger,
    });

    await expect(chat.rotateKeys()).resolves.toEqual({ reencrypted: 1, unreadable: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), {
      unknownKey: 1,
      corrupt: 0,
    });

    // The unreadable row stays where it was, and the rotated one now needs only the new key.
    const rows = await getTestDb().select().from(userCredentials);
    expect(rows.find((row) => row.service === "mistral")).toBeDefined();
    const onlyNew = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: [keyB],
      basePath: "/api/chat",
      logger,
    });
    await onlyNew.start();
    await onlyNew.stop();
    await expect(
      listCredentials(createTestDeps({ keyEncryptionSecrets: [keyB] }), user.id),
    ).resolves.toEqual([{ service: "openai", hint: "…abcd", verified: true }]);
  });
});
