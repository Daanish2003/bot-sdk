import { describe, expect, it } from "vitest";

import { fakePngBase64 } from "../../../core/server/chat/fake-image-adapter";
import { createTestSdk } from "../../support/deps";
import { insertConversation, insertMessage } from "../../support/conversations";
import { insertGeneratedImage } from "../../support/generated-images";
import { createTestChat } from "../../support/sdk";
import { insertUser, type TestUser } from "../../support/users";

const pngBytes = new Uint8Array(Buffer.from(fakePngBase64, "base64"));

/** The public path of a Generated image on a Shared link. */
const sharedImagePath = (token: string, id: string) =>
  `http://localhost/api/chat/shared/${token}/generated-images/${id}`;

/**
 * A Conversation of `owner` with a question and a reply that carries an image. The reply is the
 * Active Branch's leaf, so a Shared link taken now shows it. Returns the link's token and the image.
 */
async function sharedImageOf(owner: TestUser, deps = createTestSdk()) {
  const conv = await insertConversation(owner, { title: "Pictures" });
  const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Draw" });
  const id = await insertGeneratedImage(deps, owner, conv.id, {
    parentId: question.id,
    active: true,
  });
  const link = await createTestChat({ user: owner, deps }).rpc.share.upsert({
    conversationId: conv.id,
  });
  return { conv, id, token: link.token };
}

describe("GET /api/chat/shared/:token/generated-images/:id", () => {
  it("serves an image on the shared path to anyone, immutable and cacheable", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const { id, token } = await sharedImageOf(owner, deps);

    const response = await createTestChat({ user: null, deps }).fetch(
      new Request(sharedImagePath(token, id)),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);
  });

  it("names the file by its short id and extension when downloaded", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const { id, token } = await sharedImageOf(owner, deps);

    const response = await createTestChat({ user: null, deps }).fetch(
      new Request(`${sharedImagePath(token, id)}?download=1`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="generated-image-${id.slice(0, 8)}.png"`,
    );
  });

  it("answers 404 for an image on a sibling Branch of the shared one", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const conv = await insertConversation(owner, { title: "Branches" });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Draw" });
    const sibling = await insertGeneratedImage(deps, owner, conv.id, { parentId: question.id });
    await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Shared reply",
      active: true,
    });
    const link = await createTestChat({ user: owner, deps }).rpc.share.upsert({
      conversationId: conv.id,
    });

    const response = await createTestChat({ user: null, deps }).fetch(
      new Request(sharedImagePath(link.token, sibling)),
    );

    expect(response.status).toBe(404);
    expect(new Uint8Array(await response.arrayBuffer())).not.toEqual(pngBytes);
  });

  it("answers 404 for an image after the shared leaf", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const conv = await insertConversation(owner, { title: "Later" });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    const reply = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Shared reply",
      active: true,
    });
    const link = await createTestChat({ user: owner, deps }).rpc.share.upsert({
      conversationId: conv.id,
    });
    // Drawn after the link was taken: a child of the shared leaf, not on the link's path.
    const later = await insertGeneratedImage(deps, owner, conv.id, {
      parentId: reply.id,
      active: true,
    });

    const response = await createTestChat({ user: null, deps }).fetch(
      new Request(sharedImagePath(link.token, later)),
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 for an unknown token", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const { id } = await sharedImageOf(owner, deps);

    const response = await createTestChat({ user: null, deps }).fetch(
      new Request(sharedImagePath("no-such-token", id)),
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 once the owner removes the link", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const { conv, id, token } = await sharedImageOf(owner, deps);
    await createTestChat({ user: owner, deps }).rpc.share.delete({ conversationId: conv.id });

    const response = await createTestChat({ user: null, deps }).fetch(
      new Request(sharedImagePath(token, id)),
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 for a blocked owner's link", async () => {
    const owner = await insertUser();
    const { id, token } = await sharedImageOf(owner);
    const blockedDeps = createTestSdk({ isUserBlocked: (userId) => userId === owner.id });

    const response = await createTestChat({ user: null, deps: blockedDeps }).fetch(
      new Request(sharedImagePath(token, id)),
    );

    expect(response.status).toBe(404);
  });
});
