import { describe, expect, it } from "vitest";

import { takeChunkReload } from "./service-worker";

/** A `sessionStorage` stand-in: the guard only needs getItem and setItem. */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("the chunk-failure reload guard", () => {
  it("reloads for the first chunk failure", () => {
    expect(takeChunkReload(memoryStorage())).toBe(true);
  });

  it("doesn't reload again while the flag from the last reload is set", () => {
    const storage = memoryStorage();
    expect(takeChunkReload(storage)).toBe(true);
    expect(takeChunkReload(storage)).toBe(false);
  });

  it("doesn't reload when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(takeChunkReload(blocked)).toBe(false);
  });
});
