import { describe, expect, it } from "vitest";

import type { BlobStore } from "../../../../core/server/storage";

/**
 * The contract every `BlobStore` meets (ADR 0015). An implementation proves it by running this
 * suite unchanged, with its own factory:
 *
 *   blobStoreContract("postgres", () => postgresBlobStore(db));
 *
 * Each test uses fresh keys, so a factory may share one store between tests.
 */
export function blobStoreContract(name: string, make: () => BlobStore | Promise<BlobStore>) {
  describe(`BlobStore contract: ${name}`, () => {
    const freshKey = () => `test/${crypto.randomUUID()}`;
    const bytesOf = (text: string) => new TextEncoder().encode(text);

    it("returns the bytes it was given, under the same key", async () => {
      const store = await make();
      const key = freshKey();

      await store.put(key, bytesOf("hello"), { contentType: "text/plain" });

      const stored = await store.get(key);
      expect(stored && new TextDecoder().decode(stored)).toBe("hello");
    });

    it("returns null for a key it never stored", async () => {
      const store = await make();

      expect(await store.get(freshKey())).toBeNull();
    });

    it("deletes many keys at once, ignoring keys that are already gone", async () => {
      const store = await make();
      const [a, b, c] = [freshKey(), freshKey(), freshKey()];
      await store.put(a, bytesOf("a"), { contentType: "text/plain" });
      await store.put(b, bytesOf("b"), { contentType: "text/plain" });
      await store.put(c, bytesOf("c"), { contentType: "text/plain" });

      await store.delete([a, b, freshKey()]);

      expect(await store.get(a)).toBeNull();
      expect(await store.get(b)).toBeNull();
      expect(await store.get(c)).not.toBeNull();
    });

    it("accepts a content type with each put and keeps the bytes intact", async () => {
      const store = await make();
      const key = freshKey();
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

      await store.put(key, png, { contentType: "image/png" });

      expect(Array.from((await store.get(key)) ?? [])).toEqual(Array.from(png));
    });
  });
}
