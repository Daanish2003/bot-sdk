import { describe, expect, it } from "vitest";

import { fakePngBase64 } from "../../../plugins/models/server/fake-image-adapter";
import { insertConversation } from "../../support/conversations";
import { createTestSdk } from "../../support/deps";
import { insertGeneratedImage } from "../../support/generated-images";
import { createTestChat } from "../../support/sdk";
import { insertUser } from "../../support/users";

const pngBytes = new Uint8Array(Buffer.from(fakePngBase64, "base64"));

/** A Generated image of `owner` in a new Conversation, and the request for its bytes. */
async function imageOf(owner: Awaited<ReturnType<typeof insertUser>>, deps = createTestSdk()) {
  const conv = await insertConversation(owner, { title: "Images" });
  const id = await insertGeneratedImage(deps, owner, conv.id);
  return { deps, id, path: `http://localhost/api/chat/generated-images/${id}` };
}

describe("GET /api/chat/generated-images/:id", () => {
  it("serves the owner the image's bytes, immutable and cacheable", async () => {
    const owner = await insertUser();
    const { deps, path } = await imageOf(owner);

    const response = await createTestChat({ user: owner, deps }).fetch(new Request(path));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);
  });

  it("names the file by its short id and extension when downloaded", async () => {
    const owner = await insertUser();
    const { deps, id, path } = await imageOf(owner);

    const response = await createTestChat({ user: owner, deps }).fetch(
      new Request(`${path}?download=1`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="generated-image-${id.slice(0, 8)}.png"`,
    );
  });

  it("answers another user 404, with no bytes", async () => {
    const owner = await insertUser();
    const stranger = await insertUser();
    const { deps, path } = await imageOf(owner);

    const response = await createTestChat({ user: stranger, deps }).fetch(new Request(path));

    expect(response.status).toBe(404);
    expect(new Uint8Array(await response.arrayBuffer())).not.toEqual(pngBytes);
  });

  it("answers 404 for an id that names no image, or is not an id", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const chat = createTestChat({ user: owner, deps });

    const missing = await chat.fetch(
      new Request(
        "http://localhost/api/chat/generated-images/0190a6c0-0000-7000-8000-000000000000",
      ),
    );
    const malformed = await chat.fetch(
      new Request("http://localhost/api/chat/generated-images/not-an-id"),
    );

    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
  });

  it("answers a signed-out caller 401", async () => {
    const owner = await insertUser();
    const { deps, path } = await imageOf(owner);

    const response = await createTestChat({ user: null, deps }).fetch(new Request(path));

    expect(response.status).toBe(401);
  });
});
