import { afterEach, describe, expect, it, vi } from "vitest";

import { blobStoreOf } from "./blob-store";

const set = {
  S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  S3_BUCKET: "ai-chat-files",
  S3_REGION: "auto",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: "secret-key",
};

describe("blobStoreOf", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps file bytes in Postgres when no S3 variable is set", () => {
    expect(blobStoreOf({})).toBeUndefined();
    expect(blobStoreOf({ S3_ENDPOINT: "", S3_BUCKET: undefined })).toBeUndefined();
  });

  it("stores bytes in the configured bucket when all five variables are set", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const store = blobStoreOf(set);

    await store?.put("attachment/1", new Uint8Array([1]), { contentType: "image/png" });

    const request = fetch.mock.calls[0]?.[0] as Request | undefined;
    expect(request?.url).toBe(
      "https://account.r2.cloudflarestorage.com/ai-chat-files/attachment/1",
    );
  });

  it("refuses a partly set store, naming what is missing", () => {
    const partial = { ...set, S3_SECRET_ACCESS_KEY: undefined };

    expect(() => blobStoreOf(partial)).toThrow(/missing S3_SECRET_ACCESS_KEY/);
  });
});
