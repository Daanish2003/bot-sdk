import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { s3BlobStore } from "@botsdk/bot/storage";
import { blobStoreContract } from "./blob.contract";
import { fakeS3 } from "./fake-s3";

const config = {
  endpoint: "http://127.0.0.1:9000",
  bucket: "ai-chat-test",
  region: "auto",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
};

describe("s3BlobStore against a fake S3 endpoint", () => {
  const s3 = fakeS3({
    bucket: config.bucket,
    region: config.region,
    accessKeyId: config.accessKeyId,
  });

  beforeAll(() => {
    vi.stubGlobal("fetch", s3.fetch);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  blobStoreContract("s3 (fake)", () => s3BlobStore(config));

  it("stores each object under its key, with the content type it was given", async () => {
    const store = s3BlobStore(config);

    await store.put("attachment/a b", new Uint8Array([1, 2]), { contentType: "image/png" });

    expect(s3.objects.get("attachment/a b")?.contentType).toBe("image/png");
  });

  it("fails a put signed with another access key", async () => {
    const store = s3BlobStore({ ...config, accessKeyId: "other-key" });

    await expect(
      store.put("k", new Uint8Array([1]), { contentType: "text/plain" }),
    ).rejects.toThrow(/403/);
  });
});

describe("s3BlobStore against a bucket that does not exist", () => {
  it("fails a get rather than reporting the object missing", async () => {
    const s3 = fakeS3({ bucket: "ai-chat-test", region: "auto", accessKeyId: "test-access-key" });
    vi.stubGlobal("fetch", s3.fetch);
    try {
      const store = s3BlobStore({ ...config, bucket: "wrong-bucket" });

      await expect(store.get("attachment/1")).rejects.toThrow(/404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
