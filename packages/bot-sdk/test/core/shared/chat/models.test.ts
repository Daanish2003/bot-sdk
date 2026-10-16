import type { AiModels } from "@cloudflare/workers-types";
import { ANTHROPIC_MODELS } from "@tanstack/ai-anthropic";
import { BEDROCK_CONVERSE_MODELS } from "@tanstack/ai-bedrock";
import { BYTEPLUS_CHAT_MODELS } from "@tanstack/ai-byteplus";
import type { CloudflareTextModel } from "@tanstack/ai-cloudflare";
import { GEMINI_MODELS } from "@tanstack/ai-gemini";
import { GROK_CHAT_MODELS } from "@tanstack/ai-grok";
import { GROQ_CHAT_MODELS } from "@tanstack/ai-groq";
import { LLMGATEWAY_CHAT_MODELS } from "@tanstack/ai-llmgateway";
import { LOVABLE_CHAT_MODELS } from "@tanstack/ai-lovable";
import { MISTRAL_CHAT_MODELS } from "@tanstack/ai-mistral";
import { OPENAI_CHAT_MODELS } from "@tanstack/ai-openai";
import { VERCEL_GATEWAY_CHAT_MODELS } from "@tanstack/ai-vercel-gateway";
import { describe, expect, it } from "vitest";

import { providers } from "../../../../core/shared/credentials/services";
import {
  curatedModels,
  defaultModelFor,
  findModel,
  isLiveListProvider,
} from "../../../../core/shared/chat/models";
import { modelsDevSnapshot } from "../../../../core/shared/chat/models-snapshot";

/**
 * `@tanstack/ai-cloudflare` exports no runtime model list: its `CloudflareTextModel` accepts any
 * id. So the curated ids are listed here and the typecheck holds them to the Workers AI catalog
 * (`AiModels`) of the `@cloudflare/workers-types` version the adapter depends on.
 */
const cloudflareCatalog: readonly (keyof AiModels & CloudflareTextModel)[] = [
  "@cf/openai/gpt-oss-120b",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/zai-org/glm-4.7-flash",
];

const packageModels: Record<string, readonly string[]> = {
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_CHAT_MODELS,
  gemini: GEMINI_MODELS,
  mistral: MISTRAL_CHAT_MODELS,
  groq: GROQ_CHAT_MODELS,
  grok: GROK_CHAT_MODELS,
  bedrock: BEDROCK_CONVERSE_MODELS,
  cloudflare: cloudflareCatalog,
  byteplus: BYTEPLUS_CHAT_MODELS,
  llmgateway: LLMGATEWAY_CHAT_MODELS,
  lovable: LOVABLE_CHAT_MODELS,
  "vercel-gateway": VERCEL_GATEWAY_CHAT_MODELS,
};

/** Providers whose adapter speaks Chat Completions, which can't send PDFs. */
const chatCompletionsProviders = new Set([
  "openrouter",
  "mistral",
  "groq",
  "cloudflare",
  "byteplus",
  "llmgateway",
]);

const curatedProviders = providers.filter(({ id }) => !isLiveListProvider(id));

describe("curated Model list", () => {
  it.each(curatedProviders)("offers 3 to 6 Models for $label", ({ id }) => {
    const count = curatedModels.filter((model) => model.provider === id).length;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThanOrEqual(6);
  });

  it("lists OpenRouter and Ollama live instead of curating them", () => {
    expect(providers.filter(({ id }) => isLiveListProvider(id)).map(({ id }) => id)).toEqual([
      "openrouter",
      "ollama",
    ]);
    expect(curatedModels.filter((model) => isLiveListProvider(model.provider))).toEqual([]);
  });

  it.each(curatedModels)("$id exists in its package's *_MODELS export", (model) => {
    expect(packageModels[model.provider]).toContain(model.modelId);
    expect(model.id).toBe(`${model.provider}:${model.modelId}`);
    expect(model.label).not.toBe("");
    expect(typeof model.images).toBe("boolean");
    expect(typeof model.pdfs).toBe("boolean");
    expect(typeof model.tools).toBe("boolean");
  });

  it("turns PDFs off for Models behind a Chat Completions adapter", () => {
    const withPdfs = curatedModels.filter(
      (model) => chatCompletionsProviders.has(model.provider) && model.pdfs,
    );
    expect(withPdfs).toEqual([]);
  });

  it("finds a Model by its provider:model id", () => {
    expect(findModel("anthropic:claude-sonnet-5-5")).toMatchObject({
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
    });
  });

  it("finds nothing for an id that isn't curated", () => {
    expect(findModel("anthropic:claude-2")).toBeUndefined();
    expect(findModel("claude-sonnet-5-5")).toBeUndefined();
    expect(findModel("gemini:claude-sonnet-5-5")).toBeUndefined();
  });
});

describe("curated Model metadata", () => {
  it.each(curatedModels)(
    "$id has a models.dev snapshot entry, or is explicitly marked unknown",
    (model) => {
      expect(Object.hasOwn(modelsDevSnapshot, model.id)).toBe(true);
    },
  );

  it("keeps no snapshot entry for a Model that isn't curated", () => {
    expect(Object.keys(modelsDevSnapshot).filter((id) => !findModel(id))).toEqual([]);
  });

  it.each(curatedModels)("exposes $id's snapshot limits, or unknown", (model) => {
    const entry = modelsDevSnapshot[model.id];
    if (entry === null || entry === undefined) {
      expect(model.contextWindow).toBeNull();
      expect(model.maxOutputTokens).toBeNull();
      expect(model.reasoning).toEqual({ efforts: [], off: false, defaultEffort: null });
      return;
    }
    expect(model.contextWindow).toBe(entry.contextWindow);
    expect(model.maxOutputTokens).toBe(entry.maxOutputTokens);
    expect(model.reasoning.efforts).toEqual(entry.efforts);
    expect(model.reasoning.off).toBe(entry.off);
  });

  it("lists no reasoning efforts for Bedrock, whose Converse API has no reasoning setting", () => {
    const bedrock = curatedModels.filter((model) => model.provider === "bedrock");
    expect(bedrock.length).toBeGreaterThan(0);
    expect(bedrock.every((model) => model.reasoning.efforts.length === 0)).toBe(true);
  });

  it("reads OpenAI's window, output cap and reasoning efforts from the snapshot", () => {
    expect(findModel("openai:gpt-5.6")).toMatchObject({
      contextWindow: 1050000,
      maxOutputTokens: 128000,
      reasoning: { efforts: ["low", "medium", "high"], off: true, defaultEffort: null },
    });
  });
});

describe("defaultModelFor", () => {
  it.each(curatedProviders)("has a curated default for $label", ({ id }) => {
    const model = defaultModelFor(id);
    expect(model && findModel(model)?.provider).toBe(id);
  });
});
