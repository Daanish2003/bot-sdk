import type { AnyEmbeddingAdapter, EmbeddingResult, TokenUsage } from "@tanstack/ai";

import { embeddingDimensions } from "./embedding-models";

export type FakeEmbeddingOptions = {
  /** The embedding Model id the adapter reports. */
  model?: string;
  /** When set, each call fails with this message. */
  fail?: string;
};

/** One call the fake adapter was asked for: its inputs as text, and the options it was given. */
export type FakeEmbeddingCall = { inputs: string[]; dimensions?: number; modelOptions?: unknown };

/** A fake embedding adapter, with every call it was asked for in `calls`, in order. */
export type FakeEmbeddingAdapter = AnyEmbeddingAdapter & { readonly calls: FakeEmbeddingCall[] };

/**
 * A scripted TanStack AI embedding adapter for tests and the CI-only fake Provider (spec #357). It
 * makes no network call. Each text becomes a hashed bag of its words in 1536 dimensions, scaled to
 * unit length: texts that share words sit near each other, and the same text always gives the
 * same vector. It reports its usage as the characters ÷ 4, the same estimate Gemini's gets.
 */
export function fakeEmbeddingAdapter(options: FakeEmbeddingOptions = {}): FakeEmbeddingAdapter {
  const calls: FakeEmbeddingCall[] = [];
  const model = options.model ?? "fake-embedding";
  // An object with the `EmbeddingAdapter` shape, as the fake image adapter is.
  const adapter = {
    kind: "embedding",
    name: "fake",
    model,
    calls,
    createEmbeddings: async (request: {
      input: unknown[];
      dimensions?: number;
      modelOptions?: unknown;
    }): Promise<EmbeddingResult> => {
      const inputs = request.input.map(textOf);
      calls.push({ inputs, dimensions: request.dimensions, modelOptions: request.modelOptions });
      if (options.fail !== undefined) throw new Error(options.fail);
      const characters = inputs.reduce((sum, text) => sum + text.length, 0);
      const usage: TokenUsage = {
        promptTokens: Math.ceil(characters / 4),
        completionTokens: 0,
        totalTokens: Math.ceil(characters / 4),
      };
      return {
        id: `fake-${calls.length}`,
        model,
        embeddings: inputs.map((text, index) => ({ index, vector: vectorOf(text) })),
        usage,
      };
    },
  };
  return adapter as unknown as FakeEmbeddingAdapter;
}

/** The text of one embedding input: a plain string, or a text part's content. */
function textOf(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object" && "content" in item && typeof item.content === "string") {
    return item.content;
  }
  throw new Error("The fake embedding adapter takes text only");
}

/** A word's bucket in the vector: FNV-1a over its UTF-16 code units, modulo the dimensions. */
function bucketOf(word: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i += 1) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % embeddingDimensions;
}

/** Each word counted into its bucket, the vector scaled to unit length. Empty text gives zeros. */
function vectorOf(text: string): number[] {
  const vector = Array.from({ length: embeddingDimensions }, () => 0);
  for (const [word] of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const bucket = bucketOf(word);
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}
