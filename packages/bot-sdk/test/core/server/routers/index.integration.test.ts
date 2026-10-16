import { describe, expect, it } from "vitest";

import { insertUser } from "../../../support/users";
import { chatRpc } from "../../../support/sdk";

describe("healthCheck", () => {
  it("answers OK to a signed-in caller", async () => {
    const client = chatRpc({ user: await insertUser() });

    await expect(client.healthCheck()).resolves.toBe("OK");
  });
});

describe("privateData", () => {
  it("rejects a caller without a session as UNAUTHORIZED", async () => {
    const client = chatRpc();

    await expect(client.privateData()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns the signed-in user", async () => {
    const user = await insertUser();
    const client = chatRpc({ user });

    const result = await client.privateData();

    expect(result.message).toBe("This is private");
    expect(result.user).toEqual({ id: user.id });
  });
});
