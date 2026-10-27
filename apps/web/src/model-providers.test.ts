import { describe, expect, it } from "vitest";

import { adaptersOf } from "@botsdk/bot/models/internal";

import { modelProviders } from "./model-providers";

// The SDK over this app's Providers, as `models.providers` builds them (spec #875).
const { adapterFor, imageAdapterFor } = adaptersOf(modelProviders);

describe("adapterFor", () => {
  it("builds the Anthropic adapter for an Anthropic Model", () => {
    const adapter = adapterFor("anthropic:claude-sonnet-5-5", { apiKey: "sk-ant-test" });

    expect(adapter).toMatchObject({ kind: "text", name: "anthropic", model: "claude-sonnet-5-5" });
  });

  it("builds the OpenAI Responses adapter for an OpenAI Model", () => {
    const adapter = adapterFor("openai:gpt-6-luna", { apiKey: "sk-test" });

    expect(adapter).toMatchObject({ kind: "text", name: "openai", model: "gpt-6-luna" });
  });

  it("refuses a Model that isn't curated", () => {
    expect(() => adapterFor("anthropic:claude-2", { apiKey: "sk-ant-test" })).toThrow(/claude-2/);
  });

  it("refuses credentials without an API key", () => {
    expect(() => adapterFor("openai:gpt-6-luna", {})).toThrow(/API key/);
  });

  it.each([
    ["gemini:gemini-3.8-flash", "gemini"],
    ["mistral:mistral-medium-latest", "mistral"],
    ["groq:openai/gpt-oss-120b", "groq"],
    ["grok:grok-4.7", "grok"],
    ["byteplus:seed-2-0-lite-260428", "byteplus"],
    ["llmgateway:claude-sonnet-5", "llmgateway"],
    ["lovable:google/gemini-3.7-flash", "lovable"],
    ["vercel-gateway:anthropic/claude-sonnet-5.5", "vercel-gateway"],
  ])("builds the %s adapter from an API key", (model, name) => {
    const adapter = adapterFor(model, { apiKey: "key-test" });

    expect(adapter).toMatchObject({ kind: "text", name, model: model.slice(name.length + 1) });
  });

  it("builds the Bedrock Converse adapter from an API key and a region", () => {
    const adapter = adapterFor("bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0", {
      apiKey: "ABSK-test",
      region: "us-west-2",
    });

    expect(adapter).toMatchObject({
      kind: "text",
      name: "bedrock-converse",
      model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    });
  });

  it("builds the Cloudflare adapter from an account id and an API token", () => {
    const adapter = adapterFor("cloudflare:@cf/openai/gpt-oss-120b", {
      accountId: "acc123",
      apiKey: "cf-token",
    });

    expect(adapter).toMatchObject({
      kind: "text",
      name: "cloudflare",
      model: "@cf/openai/gpt-oss-120b",
    });
  });

  it("refuses Cloudflare credentials without an account id", () => {
    expect(() => adapterFor("cloudflare:@cf/openai/gpt-oss-120b", { apiKey: "cf-token" })).toThrow(
      /account id/,
    );
  });

  it("builds the OpenRouter adapter for any live-listed OpenRouter Model", () => {
    const adapter = adapterFor("openrouter:deepseek/deepseek-v4-pro", { apiKey: "sk-or-test" });

    expect(adapter).toMatchObject({
      kind: "text",
      name: "openrouter",
      model: "deepseek/deepseek-v4-pro",
    });
  });

  it("builds the Ollama adapter for an installed Model from the host alone", () => {
    const adapter = adapterFor("ollama:llama3.2:latest", { host: "http://localhost:11434" });

    expect(adapter).toMatchObject({ kind: "text", name: "ollama", model: "llama3.2:latest" });
  });

  it("refuses Ollama credentials without a host", () => {
    expect(() => adapterFor("ollama:llama3.2:latest", {})).toThrow(/host/);
  });
});

describe("imageAdapterFor", () => {
  it.each([
    ["openai:gpt-image-1-mini", { apiKey: "sk-test" }, "openai", "gpt-image-1-mini"],
    ["gemini:gemini-3.1-flash-image", { apiKey: "key-test" }, "gemini", "gemini-3.1-flash-image"],
    ["grok:grok-imagine-image", { apiKey: "xai-test" }, "grok", "grok-imagine-image"],
    [
      "openrouter:openai/gpt-5-image-mini",
      { apiKey: "sk-or-test" },
      "openrouter",
      "openai/gpt-5-image-mini",
    ],
    ["byteplus:seedream-5-0-260128", { apiKey: "ark-test" }, "byteplus", "seedream-5-0-260128"],
    ["lovable:openai/gpt-image-2", { apiKey: "key-test" }, "lovable", "openai/gpt-image-2"],
    [
      "vercel-gateway:openai/gpt-image-2",
      { apiKey: "key-test" },
      "vercel-gateway",
      "openai/gpt-image-2",
    ],
    [
      "cloudflare:@cf/black-forest-labs/flux-1-schnell",
      { accountId: "acc123", apiKey: "cf-token" },
      "cloudflare",
      "@cf/black-forest-labs/flux-1-schnell",
    ],
  ])("builds the image adapter for %s", (model, credentials, name, modelId) => {
    const adapter = imageAdapterFor(model, credentials);

    expect(adapter).toMatchObject({ kind: "image", name, model: modelId });
  });

  it("refuses a Provider with no image adapter", () => {
    expect(() => imageAdapterFor("anthropic:claude-sonnet-5-5", { apiKey: "sk-ant-test" })).toThrow(
      /No image adapter .*anthropic/,
    );
  });

  it("refuses credentials without an API key", () => {
    expect(() => imageAdapterFor("openai:gpt-image-1-mini", {})).toThrow(/API key/);
  });

  it("refuses Cloudflare credentials without an account id", () => {
    expect(() =>
      imageAdapterFor("cloudflare:@cf/black-forest-labs/flux-1-schnell", { apiKey: "cf-token" }),
    ).toThrow(/account id/);
  });
});
