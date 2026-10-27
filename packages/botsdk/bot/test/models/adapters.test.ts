import type { AnyImageAdapter, AnyTextAdapter } from "@tanstack/ai";
import { describe, expect, it, vi } from "vitest";

import { adaptersOf, imageRequestFor, type ModelProvider } from "../../src/models/internal";

type TextFactory = NonNullable<ModelProvider["text"]>;

const textAdapter = { name: "text" } as unknown as AnyTextAdapter;
const imageAdapter = { name: "image" } as unknown as AnyImageAdapter;

describe("adaptersOf", () => {
  it("builds a Model's text adapter with the Provider the Host passed", () => {
    const text = vi.fn<TextFactory>(() => textAdapter);
    const { adapterFor } = adaptersOf({ anthropic: { text } });

    expect(adapterFor("anthropic:claude-sonnet-5-5", { apiKey: "sk-ant" }).name).toBe("text");
    expect(text).toHaveBeenCalledWith("claude-sonnet-5-5", { apiKey: "sk-ant" }, {});
  });

  it("refuses a Model that isn't available and a Provider the Host didn't pass", () => {
    const { adapterFor } = adaptersOf({ anthropic: { text: () => textAdapter } });

    expect(() => adapterFor("anthropic:claude-2", { apiKey: "k" })).toThrow(/claude-2/);
    expect(() => adapterFor("openai:gpt-6-luna", { apiKey: "k" })).toThrow(/openai Provider/);
  });

  it("sends a linked ChatGPT plan's call through the plan's fetch (ADR 0023)", () => {
    const text = vi.fn<TextFactory>(() => textAdapter);
    const { adapterFor } = adaptersOf({ openai: { text, honoursFetch: true } });

    adapterFor("openai:gpt-6-luna", { apiKey: "t" }, { linked: true });
    adapterFor("openai:gpt-6-luna", { apiKey: "sk-own" });

    expect(text.mock.calls[0]![2]).toEqual({ fetch: expect.any(Function) });
    expect(text.mock.calls[1]![2]).toEqual({});
  });

  it("builds an Image Model's adapter, and none for a Provider without images", () => {
    const image = vi.fn<NonNullable<ModelProvider["image"]>>(() => imageAdapter);
    const { imageAdapterFor } = adaptersOf({ openai: { image }, anthropic: {} });

    expect(imageAdapterFor("openai:gpt-image-2", { apiKey: "sk" })).toBe(imageAdapter);
    expect(image).toHaveBeenCalledWith("gpt-image-2", { apiKey: "sk" });
    expect(() => imageAdapterFor("anthropic:claude-sonnet-5-5", { apiKey: "k" })).toThrow(
      /anthropic Provider/,
    );
  });
});

describe("adaptersOf on a linked ChatGPT plan (ADR 0023)", () => {
  it("refuses to run a plan Model on a Provider that doesn't declare it honours fetch, so the token never goes to the public API", () => {
    const text = vi.fn<TextFactory>(() => textAdapter);
    const { adapterFor } = adaptersOf({ openai: { text } });

    expect(() => adapterFor("openai:gpt-6-luna", { apiKey: "t" }, { linked: true })).toThrow(
      /honoursFetch/,
    );
    expect(text).not.toHaveBeenCalled();
  });
});

describe("adaptersOf and Stop (issue #54)", () => {
  /** A stock adapter that sends one request through `wrapFetch` and records its signal. */
  function fetchingAdapter() {
    const signals: Array<AbortSignal | null | undefined> = [];
    const send = (wrapFetch?: (next: typeof fetch) => typeof fetch) => {
      const base: typeof fetch = async (_input, init) => {
        signals.push(init?.signal);
        return new Response("{}");
      };
      return (wrapFetch ? wrapFetch(base) : base)("https://provider.test", {});
    };
    const adapter = {
      name: "stock",
      async *chatStream(options: { wrapFetch?: (next: typeof fetch) => typeof fetch }) {
        yield await send(options.wrapFetch);
      },
      async structuredOutput(options: {
        chatOptions: { wrapFetch?: (next: typeof fetch) => typeof fetch };
      }) {
        await send(options.chatOptions.wrapFetch);
        return { data: {}, rawText: "{}" };
      },
      async *structuredOutputStream(options: {
        chatOptions: { wrapFetch?: (next: typeof fetch) => typeof fetch };
      }) {
        yield await send(options.chatOptions.wrapFetch);
      },
    } as unknown as AnyTextAdapter;
    return { adapter, signals };
  }

  it("hands the run's abort signal to every request of a stock adapter", async () => {
    const { adapter, signals } = fetchingAdapter();
    const run = new AbortController();
    const wrapped = adaptersOf({ anthropic: { text: () => adapter } }).adapterFor(
      "anthropic:claude-sonnet-5-5",
      { apiKey: "k" },
    );

    for await (const _ of wrapped.chatStream({ request: { signal: run.signal } } as never));
    await wrapped.structuredOutput({
      chatOptions: { request: { signal: run.signal } },
    } as never);
    for await (const _ of wrapped.structuredOutputStream!({
      chatOptions: { request: { signal: run.signal } },
    } as never));
    run.abort();

    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });
});

describe("adaptersOf's text adapter", () => {
  it("is the Provider's adapter otherwise: its other members, and no method it lacks", () => {
    class Stock {
      kind = "text" as const;
      model = "claude-sonnet-5-5";
      #secret = "own";
      secret() {
        return this.#secret;
      }
    }
    const stock = new Stock();
    const wrapped = adaptersOf({
      anthropic: { text: () => stock as unknown as AnyTextAdapter },
    }).adapterFor("anthropic:claude-sonnet-5-5", { apiKey: "k" }) as unknown as Stock &
      AnyTextAdapter;

    expect(wrapped).toBeInstanceOf(Stock);
    expect(wrapped.kind).toBe("text");
    expect(wrapped.model).toBe("claude-sonnet-5-5");
    expect(wrapped.secret()).toBe("own");
    expect(wrapped.structuredOutputStream).toBeUndefined();
  });
});

describe("imageRequestFor", () => {
  it.each([
    ["openai:gpt-image-1-mini", "square", "1024x1024"],
    ["openai:gpt-image-1-mini", "landscape", "1536x1024"],
    ["openai:gpt-image-1-mini", "portrait", "1024x1536"],
    ["openai:dall-e-3", "landscape", "1792x1024"],
    ["openai:dall-e-3", "portrait", "1024x1792"],
    ["gemini:gemini-3.1-flash-image", "square", "1:1_1K"],
    ["gemini:gemini-3.1-flash-image", "landscape", "16:9_1K"],
    ["gemini:gemini-3.1-flash-image", "portrait", "9:16_1K"],
    ["grok:grok-imagine-image", "square", "1:1"],
    ["grok:grok-imagine-image", "landscape", "16:9"],
    ["grok:grok-imagine-image", "portrait", "9:16"],
    ["byteplus:seedream-5-0-260128", "square", "2048x2048"],
    ["byteplus:seedream-5-0-260128", "landscape", "2560x1440"],
    ["byteplus:seedream-5-0-260128", "portrait", "1440x2560"],
    ["openrouter:openai/gpt-5-image-mini", "square", "1024x1024"],
    ["openrouter:openai/gpt-5-image-mini", "landscape", "1248x832"],
    ["openrouter:openai/gpt-5-image-mini", "portrait", "832x1248"],
    ["lovable:openai/gpt-image-2", "landscape", "1536x1024"],
    ["vercel-gateway:openai/gpt-image-2", "portrait", "1024x1536"],
    ["cloudflare:@cf/black-forest-labs/flux-1-schnell", "landscape", "1536x1024"],
  ] as const)("maps %s %s to %s", (model, aspectRatio, size) => {
    expect(imageRequestFor(model, aspectRatio)).toEqual({ size });
  });

  it("uses the Host Image Model's pinned size and quality, whatever the aspect ratio", () => {
    expect(
      imageRequestFor("openai:gpt-image-1-mini", "landscape", {
        size: "1024x1024",
        quality: "medium",
      }),
    ).toEqual({ size: "1024x1024", modelOptions: { quality: "medium" } });
  });

  it("passes no quality for a Provider without one", () => {
    expect(
      imageRequestFor("grok:grok-imagine-image", "square", { size: "16:9", quality: "high" }),
    ).toEqual({ size: "16:9" });
  });
});
