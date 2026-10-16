import { embed } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { fakeEmbeddingAdapter } from "../../../../core/server/chat/fake-embedding-adapter";

/** The cosine of two unit vectors: their dot product. */
function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
}

async function vectorOf(text: string): Promise<number[]> {
  const result = await embed({
    adapter: fakeEmbeddingAdapter(),
    input: text,
    dimensions: 1536,
  });
  return result.embeddings[0]!.vector;
}

describe("the fake embedding adapter", () => {
  it("answers 1536-dimension vectors, one per input, in order", async () => {
    const result = await embed({
      adapter: fakeEmbeddingAdapter(),
      input: ["a red guitar", "a blue drum kit"],
      dimensions: 1536,
    });

    expect(result.embeddings.map((embedding) => embedding.index)).toEqual([0, 1]);
    for (const { vector } of result.embeddings) {
      expect(vector).toHaveLength(1536);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    }
  });

  it("is deterministic: the same text gives the same vector every time", async () => {
    expect(await vectorOf("a red guitar")).toEqual(await vectorOf("a red guitar"));
  });

  it("puts texts that share words nearer each other than texts that share none", async () => {
    const guitar = await vectorOf("a red guitar");
    const solo = await vectorOf("red guitar solo");
    const tax = await vectorOf("quarterly tax filing");

    expect(cosine(guitar, solo)).toBeGreaterThan(cosine(guitar, tax));
    expect(cosine(guitar, solo)).toBeGreaterThan(0.5);
  });

  it("records each call's inputs and requested dimensions", async () => {
    const adapter = fakeEmbeddingAdapter({ model: "text-embedding-3-small" });

    await embed({ adapter, input: ["one", "two"], dimensions: 1536 });

    expect(adapter.calls).toEqual([
      expect.objectContaining({ inputs: ["one", "two"], dimensions: 1536 }),
    ]);
    expect(adapter.model).toBe("text-embedding-3-small");
  });

  it("refuses with the message it was given", async () => {
    const adapter = fakeEmbeddingAdapter({ fail: "provider down" });

    await expect(embed({ adapter, input: "hi", dimensions: 1536 })).rejects.toThrow(
      "provider down",
    );
  });
});
