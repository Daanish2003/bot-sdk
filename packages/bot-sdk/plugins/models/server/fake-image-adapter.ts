import type { AnyImageAdapter, ImageGenerationResult, TokenUsage } from "@tanstack/ai";

import { ImageRefusedError } from "../../assistant/server/deps";

/**
 * A fixed 1 x 1 PNG, the picture every fake image adapter returns. A test checks its size, not
 * its pixels.
 */
export const fakePngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export type FakeImageOptions = {
  /** The Image Model id the adapter reports. */
  model?: string;
  /** How long each call takes before it returns, in milliseconds. A call cut off meanwhile rejects. */
  delayMs?: number;
  /** When set, each call is refused by the Provider's safety filter, with this message. */
  refuse?: string;
  /** When set, each call fails with this message. */
  fail?: string;
  /** The usage each call reports: tokens and, when the Provider bills one, its cost. Omitted reports none. */
  usage?: FakeImageUsage;
  /** When set, a call ignores its abort signal and runs to its end, as an adapter that doesn't cancel upstream does. */
  ignoresAbort?: boolean;
};

/** The usage a fake call reports: the token counts, a token breakdown, and a cost when one is billed. */
export type FakeImageUsage = {
  promptTokens?: number;
  completionTokens?: number;
  /** Image input tokens, within `promptTokens`. */
  imageTokens?: number;
  /** Text input tokens, within `promptTokens`. */
  textTokens?: number;
  cost?: number;
};

/** One call the fake adapter was asked for: the prompt and the size it was given, if any. */
export type FakeImageCall = { prompt: unknown; size?: string };

/** A fake image adapter, with every call it was asked for in `calls`, in order. */
export type FakeImageAdapter = AnyImageAdapter & { readonly calls: FakeImageCall[] };

/**
 * A scripted TanStack AI image adapter for tests and for the CI-only `HOST_IMAGE_PROVIDER=fake`
 * (spec #278). It makes no network call, and answers with the fixed PNG, after `delayMs`, or with
 * the refusal or failure it was given.
 */
export function fakeImageAdapter(options: FakeImageOptions = {}): FakeImageAdapter {
  const calls: FakeImageCall[] = [];
  const model = options.model ?? "fake-image";
  // An object with the `ImageAdapter` shape: TanStack AI's base class isn't exported from its root.
  const adapter = {
    kind: "image",
    name: "fake",
    model,
    calls,
    generateImages: async (request: {
      prompt: unknown;
      size?: string;
      abortSignal?: AbortSignal;
    }): Promise<ImageGenerationResult> => {
      calls.push({ prompt: request.prompt, size: request.size });
      await delay(options.delayMs ?? 0, options.ignoresAbort ? undefined : request.abortSignal);
      if (options.refuse !== undefined) throw new ImageRefusedError(options.refuse);
      if (options.fail !== undefined) throw new Error(options.fail);
      return {
        id: `fake-${calls.length}`,
        model,
        images: [{ b64Json: fakePngBase64 }],
        ...(options.usage && { usage: tokenUsageOf(options.usage) }),
      };
    },
  };
  return adapter as unknown as FakeImageAdapter;
}

/** The `TokenUsage` a fake call reports: its totals, the token breakdown, and a cost when set. */
function tokenUsageOf(usage: FakeImageUsage): TokenUsage {
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(usage.cost !== undefined && { cost: usage.cost }),
    ...((usage.imageTokens !== undefined || usage.textTokens !== undefined) && {
      promptTokensDetails: { imageTokens: usage.imageTokens, textTokens: usage.textTokens },
    }),
  };
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
