import type { ContentPart, ModelMessage } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import {
  maxHistoryImageBytes,
  resolveImageRefs,
  userImageLeftOut,
  copyUploads,
  maxInlineImageBytes,
  sentFileBlobKey,
} from "../../../../plugins/bot/server/conversation";
import type { ComputerHandle } from "../../../../plugins/computer/server/internal";

/** A user Message with the image of file `id`, as a Turn's input stores it. */
const withImage = (id: string): ModelMessage => ({
  role: "user",
  content: [
    { type: "text", content: `see ${id}` },
    { type: "image", source: { type: "url", value: `bot-file:${id}`, mimeType: "image/png" } },
  ],
});

/** A blob store holding `size` bytes for each of `ids`, counting its reads. */
function storeOf(ids: string[], size: number) {
  const reads: string[] = [];
  return {
    reads,
    get: async (key: string) => {
      reads.push(key);
      return ids.some((id) => key === sentFileBlobKey(id)) ? new Uint8Array(size) : null;
    },
  };
}

const partsOf = (messages: ModelMessage[]) => messages.flatMap((m) => m.content as ContentPart[]);

describe("the user's images in a model call", () => {
  it("sends the newest images up to the history's byte budget, and leaves the older ones out", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    // Each image is the largest sent inline: the budget holds only so many of them.
    const store = storeOf(ids, maxInlineImageBytes);
    const resolved = await resolveImageRefs(store, ids.map(withImage), { seesImages: true });

    const fits = Math.floor(maxHistoryImageBytes / maxInlineImageBytes);
    expect(fits).toBeLessThan(ids.length);
    const images = partsOf(resolved).filter((part) => part.type === "image");
    expect(images).toHaveLength(fits);
    // The newest are kept: the last messages hold the images, the first the note.
    expect(partsOf(resolved.slice(-fits)).filter((p) => p.type === "image")).toHaveLength(fits);
    expect(partsOf(resolved.slice(0, ids.length - fits))).toContainEqual({
      type: "text",
      content: userImageLeftOut,
    });
    // Past the image that went over the budget, none is read from the blob store.
    expect(store.reads).not.toContain(sentFileBlobKey("a"));
  });

  it("sends no image of the user's to a Model that can't see, and reads none", async () => {
    const store = storeOf(["a"], 10);
    const resolved = await resolveImageRefs(store, [withImage("a")], { seesImages: false });
    expect(partsOf(resolved).filter((part) => part.type === "image")).toEqual([]);
    expect(store.reads).toEqual([]);
  });
});

describe("copying the user's files onto the Computer", () => {
  /** A Computer whose writes fail from the `failFrom`th on, holding `existing` in uploads/. */
  function computerOf(failFrom: number, existing: string[] = []) {
    const written: string[] = [];
    const handle = {
      list: async () => existing.map((name) => ({ name, kind: "file" as const, size: 1 })),
      writeFile: async (path: string) => {
        if (written.length + 1 >= failFrom) throw new Error("disk full");
        written.push(path);
      },
    } as unknown as ComputerHandle;
    return { handle, written };
  }
  const blobs = {
    blobStore: {
      get: async () => new Uint8Array([1]),
      put: async () => {},
      delete: async () => {},
    },
  };
  const file = (name: string) => ({ id: name, name, size: 1, mediaType: "text/plain" });

  it("keeps the paths of the files written before a write failed", async () => {
    const { handle } = computerOf(3);
    const paths = await copyUploads(blobs, handle, "b", [
      file("1.txt"),
      file("2.txt"),
      file("3.txt"),
    ]);
    expect(paths).toEqual(["uploads/1.txt", "uploads/2.txt", null]);
  });

  it("names a file apart from one already in uploads/", async () => {
    const { handle } = computerOf(99, ["a.txt", "a (2).txt"]);
    expect(await copyUploads(blobs, handle, "b", [file("a.txt")])).toEqual(["uploads/a (3).txt"]);
  });
});
