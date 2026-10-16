import { describe, expect, it } from "vitest";

import {
  ChunkLimitExceededError,
  chunkText,
} from "../../../../plugins/assistant/server/knowledge/chunker";

/** The settings of spec #357: 1,024-token passages, 200 shared, at least 100 characters, 5,000 at most. */
const settings = {
  chunkSize: 1024,
  chunkOverlap: 200,
  minCharactersPerChunk: 100,
  maxChunks: 5000,
};

/** Paragraphs of about 500 characters, each with its own number, so passages can be told apart. */
function paragraphs(count: number) {
  return Array.from(
    { length: count },
    (_, n) => `Paragraph ${n} says ${"words ".repeat(90)}end ${n}.`,
  ).join("\n\n");
}

describe("the Knowledge text chunker (ported from Sim)", () => {
  it("gives no passages for blank text", () => {
    expect(chunkText("   \n\n  ", settings)).toEqual([]);
  });

  it("keeps a short text as one passage", () => {
    const text = "A short note about coastal erosion, long enough to keep.";

    const chunks = chunkText(text, settings);

    expect(chunks.map((chunk) => chunk.text)).toEqual([text]);
  });

  it("splits a long text into passages of about 1,024 tokens (4,096 characters)", () => {
    const chunks = chunkText(paragraphs(60), settings);

    expect(chunks.length).toBeGreaterThan(1);
    // A passage is at most 1,024 tokens, plus the 200-token overlap carried from the one before.
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(4_096 + 800 + 1);
  });

  it("starts each passage with words from the end of the one before (a 200-token overlap)", () => {
    const chunks = chunkText(paragraphs(60), settings);

    for (let index = 1; index < chunks.length; index++) {
      const previous = chunks[index - 1]!.text;
      const [firstWord] = chunks[index]!.text.split(" ");
      expect(previous.slice(-800)).toContain(firstWord!);
    }
  });

  it("estimates each passage's tokens as characters ÷ 4", () => {
    const [chunk] = chunkText("x".repeat(400) + " " + "y".repeat(200), settings);

    expect(chunk?.tokenCount).toBe(Math.ceil(chunk!.text.length / 4));
  });

  it("refuses a text that would make more passages than the limit", () => {
    expect(() => chunkText(paragraphs(60), { ...settings, maxChunks: 3 })).toThrow(
      ChunkLimitExceededError,
    );
  });
});
