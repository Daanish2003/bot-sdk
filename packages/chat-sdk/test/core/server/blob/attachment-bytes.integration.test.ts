import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { deleteOrphanAttachments, saveAttachment } from "../../../../core/server/attachments/store";
import { s3BlobStore } from "../../../../core/server/blob/s3";
import { attachmentBlobKey, type BlobStore } from "../../../../core/server/blob/store";
import { attachment } from "../../../../core/server/db/schema/attachment";
import { blob } from "../../../../core/server/db/schema/blob";
import { deleteUserData } from "../../../../core/server/delete-user";
import { insertAttachment } from "../../../support/attachments";
import { createTestDeps } from "../../../support/deps";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeS3 } from "./fake-s3";

const longAgo = () => new Date(Date.now() - 25 * 60 * 60 * 1000);
const upload = (text: string) => ({
  filename: "notes.txt",
  mediaType: "text/plain",
  bytes: new TextEncoder().encode(text),
});

/** A store in memory, with the keys it holds. */
function memoryBlobStore() {
  const held = new Map<string, Uint8Array>();
  const store: BlobStore = {
    put: async (key, bytes) => void held.set(key, bytes),
    get: async (key) => held.get(key) ?? null,
    delete: async (keys) => {
      for (const key of keys) held.delete(key);
    },
  };
  return { store, held };
}

/** A store whose every delete fails, as an object store does when it is down. */
const failingDeletes: BlobStore = {
  put: async () => {},
  get: async () => null,
  delete: async () => {
    throw new Error("Object store is down");
  },
};

describe("saveAttachment", () => {
  it("leaves no bytes behind when the row insert fails after the upload", async () => {
    const user = await insertUser();
    const { store, held } = memoryBlobStore();
    const db = getTestDb();
    // Every insert fails; the rest of the database works as usual.
    const failingInserts = new Proxy(db, {
      get(target, property) {
        if (property === "insert") {
          return () => {
            throw new Error("insert failed");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(
      saveAttachment(
        { db: failingInserts, blobStore: store, logger: { error: () => {} } },
        user.id,
        upload("x"),
      ),
    ).rejects.toThrow("insert failed");

    expect(held.size).toBe(0);
  });

  it("stores the bytes under attachment/<id> in the Host's blob store", async () => {
    const user = await insertUser();
    const { store, held } = memoryBlobStore();
    const deps = createTestDeps({ blobStore: store });

    const saved = await saveAttachment(deps, user.id, upload("hello"));

    expect(new TextDecoder().decode(held.get(attachmentBlobKey(saved.id)))).toBe("hello");
  });
});

describe("deleteOrphanAttachments", () => {
  it("removes the bytes of the orphans it deletes, in the default store", async () => {
    const user = await insertUser();
    const orphan = await insertAttachment(user, { createdAt: longAgo() });

    await deleteOrphanAttachments(createTestDeps(), new Date());

    const left = await getTestDb()
      .select({ key: blob.key })
      .from(blob)
      .where(eq(blob.key, attachmentBlobKey(orphan.id)));
    expect(left).toEqual([]);
  });

  it("removes the orphans' bytes from a Host's blob store after the commit", async () => {
    const user = await insertUser();
    const { store, held } = memoryBlobStore();
    const deps = createTestDeps({ blobStore: store });
    const orphan = await saveAttachment(deps, user.id, upload("old"));
    await getTestDb()
      .update(attachment)
      .set({ createdAt: longAgo() })
      .where(eq(attachment.id, orphan.id));

    await deleteOrphanAttachments(deps, new Date());

    expect(held.has(attachmentBlobKey(orphan.id))).toBe(false);
  });

  it("logs a failed blob delete and does not throw it", async () => {
    const user = await insertUser();
    const logger = { error: vi.fn() };
    const orphan = await insertAttachment(user, { createdAt: longAgo() });
    const deps = createTestDeps({ blobStore: failingDeletes, logger });

    await expect(deleteOrphanAttachments(deps, new Date())).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledOnce();
    const rows = await getTestDb()
      .select({ id: attachment.id })
      .from(attachment)
      .where(eq(attachment.id, orphan.id));
    expect(rows).toEqual([]);
  });
});

describe("an S3 blob store", () => {
  it("holds an Attachment's bytes until the orphan cleanup removes them", async () => {
    const config = { bucket: "ai-chat-test", region: "auto", accessKeyId: "key" };
    const s3 = fakeS3(config);
    vi.stubGlobal("fetch", s3.fetch);
    try {
      const store = s3BlobStore({
        endpoint: "http://127.0.0.1:9000",
        ...config,
        secretAccessKey: "secret",
      });
      const user = await insertUser();
      const deps = createTestDeps({ blobStore: store });
      const saved = await saveAttachment(deps, user.id, upload("hello s3"));
      expect(s3.objects.has(attachmentBlobKey(saved.id))).toBe(true);
      await getTestDb()
        .update(attachment)
        .set({ createdAt: longAgo() })
        .where(eq(attachment.id, saved.id));

      await deleteOrphanAttachments(deps, new Date());

      expect(s3.objects.has(attachmentBlobKey(saved.id))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("deleteUserData", () => {
  it("removes the bytes of the user's Attachments from a Host's blob store", async () => {
    const user = await insertUser();
    const { store, held } = memoryBlobStore();
    const deps = createTestDeps({ blobStore: store });
    const saved = await saveAttachment(deps, user.id, upload("bye"));

    await deleteUserData(deps, user.id);

    expect(held.has(attachmentBlobKey(saved.id))).toBe(false);
  });

  it("logs a failed blob delete and does not throw it, and the rows are gone", async () => {
    const user = await insertUser();
    const logger = { error: vi.fn() };
    const kept = await insertAttachment(user);
    const deps = createTestDeps({ blobStore: failingDeletes, logger });

    await expect(deleteUserData(deps, user.id)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledOnce();
    const rows = await getTestDb()
      .select({ id: attachment.id })
      .from(attachment)
      .where(eq(attachment.id, kept.id));
    expect(rows).toEqual([]);
  });
});
