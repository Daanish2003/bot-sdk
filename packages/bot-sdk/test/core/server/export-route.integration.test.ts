import { describe, expect, it } from "vitest";

import { exportUserData } from "../../../core/server/export-user";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestDeps } from "../../support/deps";
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
    const deps = createTestDeps();
    const owner = await insertUser();
    const conv = await insertConversation(owner, { title: "Exported" });
    await insertMessage({ conversationId: conv.id, role: "user", text: "Hi", active: true });

    const response = await createTestChat({ user: owner, deps }).fetch(exportRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="chat-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const body = await response.json();
    expect(withoutTimestamp(body)).toEqual(withoutTimestamp(await exportUserData(deps, owner.id)));
    expect(body.conversations).toEqual([expect.objectContaining({ title: "Exported" })]);
  });

  it("refuses a signed-out caller with 401 and no document", async () => {
    const response = await createTestChat({ user: null }).fetch(exportRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("content-disposition")).toBeNull();
  });
});
