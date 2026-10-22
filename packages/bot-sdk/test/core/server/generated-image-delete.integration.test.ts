import { like, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { deleteUserData } from "../../../core/server/user-data";
import { sweepExpiredTemporaryConversations } from "../../../plugins/assistant/server/chat/temporary";
import { blob, generatedImage, project } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { insertConversation } from "../../support/conversations";
import { createTestSdk, chatRpc } from "../../support/assistant";
import { insertGeneratedImage } from "../../support/generated-images";
import { getTestDb } from "../../support/test-database";
import { insertUser, type TestUser } from "../../support/users";

/** The `generated_image` rows of a user, and the blob keys of their bytes. */
async function remainingOf(userId: string) {
  const db = getTestDb();
  const rows = await db
    .select({ id: generatedImage.id })
    .from(generatedImage)
    .where(eq(generatedImage.userId, userId));
  const keys = await db
    .select({ key: blob.key })
    .from(blob)
    .where(like(blob.key, "generated-image/%"));
  return { rows: rows.map((row) => row.id), keys: keys.map((row) => row.key) };
}

/** Two of the user's images, in two Conversations, so a delete can be told apart from the rest. */
async function twoImagesOf(user: TestUser) {
  const deps = createTestSdk();
  const first = await insertConversation(user, { title: "First" });
  const second = await insertConversation(user, { title: "Second" });
  const firstImage = await insertGeneratedImage(deps, user, first.id);
  const secondImage = await insertGeneratedImage(deps, user, second.id);
  return { deps, first, second, firstImage, secondImage };
}

describe("deleting a Conversation removes its Generated images", () => {
  it("deletes the rows, then the bytes, of that Conversation only", async () => {
    const owner = await insertUser();
    const { deps, first, firstImage, secondImage } = await twoImagesOf(owner);

    await chatRpc({ user: owner, deps }).conversation.delete({ id: first.id });

    expect((await remainingOf(owner.id)).rows).toEqual([secondImage]);
    expect((await remainingOf(owner.id)).keys).toEqual([`generated-image/${secondImage}`]);
    expect(await deps.blobStore.get(`generated-image/${firstImage}`)).toBeNull();
  });

  it("deletes every Conversation's images with deleteAll", async () => {
    const owner = await insertUser();
    const { deps } = await twoImagesOf(owner);

    await chatRpc({ user: owner, deps }).conversation.deleteAll();

    expect(await remainingOf(owner.id)).toEqual({ rows: [], keys: [] });
  });

  it("logs a failing blob delete and still deletes the rows", async () => {
    const owner = await insertUser();
    const logged = vi.fn();
    const base = createTestSdk();
    const deps = createTestSdk({
      logger: { error: logged },
      blobStore: {
        ...base.blobStore,
        delete: async () => {
          throw new Error("object store is down");
        },
      },
    });
    const conv = await insertConversation(owner, { title: "Doomed" });
    await insertGeneratedImage(deps, owner, conv.id);

    await expect(
      chatRpc({ user: owner, deps }).conversation.delete({ id: conv.id }),
    ).resolves.toBeUndefined();

    expect((await remainingOf(owner.id)).rows).toEqual([]);
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe("deleting a Project removes its Conversations' Generated images", () => {
  it("deletes the rows and the bytes", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const [projectRow] = await getTestDb()
      .insert(project)
      .values({ id: uuidv7(), userId: owner.id, name: "Images" })
      .returning();
    const conv = await insertConversation(owner, {
      title: "In a project",
      projectId: projectRow!.id,
    });
    const image = await insertGeneratedImage(deps, owner, conv.id);

    await chatRpc({ user: owner, deps }).project.delete({ id: projectRow!.id });

    expect(await remainingOf(owner.id)).toEqual({ rows: [], keys: [] });
    expect(await deps.blobStore.get(`generated-image/${image}`)).toBeNull();
  });
});

describe("deleting a user removes their Generated images", () => {
  it("deletes the rows and the bytes, and leaves other users' images alone", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const deps = createTestSdk();
    const conv = await insertConversation(owner, { title: "Mine" });
    const ownImage = await insertGeneratedImage(deps, owner, conv.id);
    const otherConv = await insertConversation(other, { title: "Theirs" });
    const otherImage = await insertGeneratedImage(deps, other, otherConv.id);

    await deleteUserData(deps, owner.id);

    expect((await remainingOf(owner.id)).rows).toEqual([]);
    expect((await remainingOf(owner.id)).keys).toEqual([`generated-image/${otherImage}`]);
    expect(await deps.blobStore.get(`generated-image/${ownImage}`)).toBeNull();
    expect(await deps.blobStore.get(`generated-image/${otherImage}`)).not.toBeNull();
  });
});

describe("sweeping an expired Temporary Conversation removes its Generated images", () => {
  it("deletes the rows and the bytes", async () => {
    const owner = await insertUser();
    const deps = createTestSdk();
    const conv = await insertConversation(owner, {
      title: "Gone",
      temporary: true,
      lastMessageAt: new Date(Date.now() - 31 * 24 * 60 * 60_000),
    });
    const image = await insertGeneratedImage(deps, owner, conv.id);

    await sweepExpiredTemporaryConversations(deps);

    expect(await remainingOf(owner.id)).toEqual({ rows: [], keys: [] });
    expect(await deps.blobStore.get(`generated-image/${image}`)).toBeNull();
  });
});
