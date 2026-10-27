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

    expect(adapterFor("anthropic:claude-sonnet-5-5", { apiKey: "sk-ant" })).toBe(textAdapter);
    expect(text).toHaveBeenCalledWith("claude-sonnet-5-5", { apiKey: "sk-ant" }, {});
  });

  it("refuses a Model that isn't available and a Provider the Host didn't pass", () => {
    const { adapterFor } = adaptersOf({ anthropic: { text: () => textAdapter } });

    expect(() => adapterFor("anthropic:claude-2", { apiKey: "k" })).toThrow(/claude-2/);
    expect(() => adapterFor("openai:gpt-6-luna", { apiKey: "k" })).toThrow(/openai Provider/);
  });

  it("sends a linked ChatGPT plan's call through the plan's fetch (ADR 0023)", () => {
    const text = vi.fn<TextFactory>(() => textAdapter);
    const { adapterFor } = adaptersOf({ openai: { text } });

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
