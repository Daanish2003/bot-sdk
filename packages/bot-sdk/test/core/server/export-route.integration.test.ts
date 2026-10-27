import { describe, expect, it } from "vitest";

import { exportUserData } from "@botsdk/bot/user-data";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createTestSdk } from "../../support/deps";
import { createTestChat } from "../../support/sdk";
import { insertUser } from "../../support/users";

const exportRequest = () => new Request("http://localhost/api/chat/export");

/** The export without its `exportedAt`, which is stamped per call. */
function withoutTimestamp(document: object) {
  const { exportedAt: _exportedAt, ...rest } = JSON.parse(JSON.stringify(document));
  return rest;
}

describe("GET /api/chat/export", () => {
  it("answers the signed-in caller's export as a JSON attachment named by the export date", async () => {
    const deps = createTestSdk();
    const owner = await insertUser();
    await saveCredentials(deps, owner.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const chat = createTestChat({ user: owner, deps });
    await chat.rpc.bots.create({ name: "Ada", model: "openai:gpt-6-luna" });

    const response = await chat.fetch(exportRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="chat-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const body = await response.json();
    expect(withoutTimestamp(body)).toEqual(withoutTimestamp(await exportUserData(deps, owner.id)));
    expect(body.bot.bots).toEqual([expect.objectContaining({ name: "Ada" })]);
  });

  it("refuses a signed-out caller with 401 and no document", async () => {
    const response = await createTestChat({ user: null }).fetch(exportRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("content-disposition")).toBeNull();
  });
});
