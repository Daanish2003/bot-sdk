import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { memorySettings } from "../../../plugins/memory/server/schema";
import { computer } from "../../../plugins/computer/server/plugin";
import { createTestSdk } from "../../support/deps";
import { chatRpc } from "../../support/sdk";
import { getTestDb } from "../../support/test-database";
import { insertUser } from "../../support/users";
import { fakeComputerProvider } from "../computer/server/fake-provider";

describe("the Memory switch procedures", () => {
  it("gets and sets the Memory switch", async () => {
    const user = await insertUser();
    const deps = createTestSdk({
      plugins: [computer({ provider: fakeComputerProvider().provider })],
    });
    const rpc = chatRpc({ user, deps });

    expect(await rpc.memory.status()).toEqual({ enabled: true, botMemoryAvailable: true });

    await rpc.memory.setEnabled({ enabled: false });
    const [settings] = await getTestDb()
      .select()
      .from(memorySettings)
      .where(eq(memorySettings.userId, user.id));
    expect(settings?.enabled).toBe(false);
    expect((await rpc.memory.status()).enabled).toBe(false);
  });

  it("has no procedures without the memory plugin", async () => {
    const user = await insertUser();
    const rpc = chatRpc({ user, deps: createTestSdk({ memory: false }) });

    await expect(rpc.memory.status()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rpc.memory.setEnabled({ enabled: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
