import { describe, expect, it } from "vitest";

import { generationOptionsFor } from "../../../../core/server/chat/generation";

/** The max output key each Provider's adapter reads from `modelOptions`. */
const maxKeys: Record<string, string> = {
  anthropic: "max_tokens",
  openai: "max_output_tokens",
  gemini: "maxOutputTokens",
  openrouter: "maxCompletionTokens",
  mistral: "max_tokens",
  groq: "max_completion_tokens",
  grok: "max_output_tokens",
  bedrock: "max_completion_tokens",
  cloudflare: "max_tokens",
  byteplus: "max_completion_tokens",
  llmgateway: "max_completion_tokens",
  lovable: "max_completion_tokens",
  "vercel-gateway": "max_completion_tokens",
};

const sample = (provider: string) =>
  provider === "openrouter" ? `${provider}:x/y` : `${provider}:m`;

describe("generationOptionsFor: max output", () => {
  it.each(Object.entries(maxKeys))("sends %s's max output under its own key", (provider, key) => {
    expect(generationOptionsFor(sample(provider), { maxOutputTokens: 4096 })).toEqual({
      [key]: 4096,
    });
  });

  it("sends no max output key when the Model's limit is unknown", () => {
    const options = generationOptionsFor("groq:qwen/qwen3-32b", { maxOutputTokens: null });
    for (const key of Object.values(maxKeys)) expect(options).not.toHaveProperty(key);
  });

  it("sends nothing for Ollama, whose live Models carry no limit", () => {
    expect(generationOptionsFor("ollama:llama3.2:latest", { maxOutputTokens: null })).toEqual({});
  });
});

describe("generationOptionsFor: reasoning effort", () => {
  type Row = [string, "low" | "medium" | "high" | "off", Record<string, unknown>];

  const rows: Array<[string, Row[]]> = [
    [
      "anthropic:claude-sonnet-5-5",
      [
        ["anthropic:claude-sonnet-5-5", "high", { effort: "high", thinking: { type: "adaptive" } }],
        ["anthropic:claude-sonnet-5-5", "off", { thinking: { type: "disabled" } }],
      ],
    ],
    [
      "openai:gpt-5.6",
      [
        ["openai:gpt-5.6", "low", { reasoning: { effort: "low" } }],
        ["openai:gpt-5.6", "off", { reasoning: { effort: "none" } }],
      ],
    ],
    [
      "gemini:gemini-3.8-flash",
      [
        ["gemini:gemini-3.8-flash", "medium", { thinkingConfig: { thinkingLevel: "MEDIUM" } }],
        ["gemini:gemini-3.8-flash", "off", { thinkingConfig: { thinkingLevel: "MINIMAL" } }],
      ],
    ],
    [
      "openrouter:x/y",
      [
        ["openrouter:x/y", "high", { reasoning: { effort: "high" } }],
        ["openrouter:x/y", "off", { reasoning: { effort: "none" } }],
      ],
    ],
    [
      "groq:openai/gpt-oss-120b",
      [
        ["groq:openai/gpt-oss-120b", "low", { reasoning_effort: "low" }],
        ["groq:openai/gpt-oss-120b", "off", { reasoning_effort: "none" }],
      ],
    ],
    [
      "grok:grok-4.7",
      [
        ["grok:grok-4.7", "medium", { reasoning: { effort: "medium" } }],
        ["grok:grok-4.7", "off", { reasoning: { effort: "none" } }],
      ],
    ],
    [
      "cloudflare:@cf/openai/gpt-oss-120b",
      [
        ["cloudflare:@cf/openai/gpt-oss-120b", "high", { reasoning_effort: "high" }],
        ["cloudflare:@cf/moonshotai/kimi-k2.6", "off", { reasoning_effort: null }],
      ],
    ],
    [
      "byteplus:seed-2-0-lite-260428",
      [
        ["byteplus:seed-2-0-lite-260428", "low", { reasoning_effort: "low" }],
        ["byteplus:seed-2-0-lite-260428", "off", { thinking: { type: "disabled" } }],
      ],
    ],
    [
      "llmgateway:claude-sonnet-5",
      [
        ["llmgateway:claude-sonnet-5", "medium", { reasoning_effort: "medium" }],
        ["llmgateway:claude-sonnet-5", "off", { reasoning_effort: "none" }],
      ],
    ],
    [
      "lovable:google/gemini-3.7-flash",
      [
        ["lovable:google/gemini-3.7-flash", "high", { reasoning: { effort: "high" } }],
        ["lovable:google/gemini-3.7-flash", "off", { reasoning: false }],
      ],
    ],
    [
      "vercel-gateway:anthropic/claude-sonnet-5.5",
      [
        ["vercel-gateway:anthropic/claude-sonnet-5.5", "low", { reasoning_effort: "low" }],
        ["vercel-gateway:anthropic/claude-sonnet-5.5", "off", { reasoning_effort: "none" }],
      ],
    ],
  ];

  it.each(rows.flatMap(([, cases]) => cases))(
    "%s at %s maps to the Provider's own shape",
    (id, effort, expected) => {
      expect(generationOptionsFor(id, { maxOutputTokens: null, effort })).toEqual(expected);
    },
  );

  it("sends no reasoning key for Bedrock Converse, which has no reasoning setting", () => {
    const id = "bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0";
    expect(generationOptionsFor(id, { maxOutputTokens: null, effort: "high" })).toEqual({});
    expect(generationOptionsFor(id, { maxOutputTokens: null, effort: "off" })).toEqual({});
  });

  it("sends no reasoning key when no effort is set", () => {
    expect(generationOptionsFor("openai:gpt-5.6", { maxOutputTokens: null })).toEqual({});
  });

  it("never sends reasoning for grok-build-0.1, which rejects it", () => {
    for (const effort of ["low", "medium", "high", "off"] as const) {
      expect(
        generationOptionsFor("grok:grok-build-0.1", { maxOutputTokens: 1000, effort }),
      ).toEqual({ max_output_tokens: 1000 });
    }
  });

  it("keeps an Anthropic thinking budget out of the request, since effort uses adaptive thinking", () => {
    const options = generationOptionsFor("anthropic:claude-opus-5-5", {
      maxOutputTokens: 8192,
      effort: "low",
    });
    expect(options).toEqual({
      max_tokens: 8192,
      effort: "low",
      thinking: { type: "adaptive" },
    });
    expect(options.thinking).not.toHaveProperty("budget_tokens");
  });

  it("never sends BytePlus an effort together with thinking disabled", () => {
    const id = "byteplus:seed-2-0-lite-260428";
    for (const effort of ["low", "medium", "high", "off"] as const) {
      const options = generationOptionsFor(id, { maxOutputTokens: null, effort });
      const disabled = (options.thinking as { type?: string } | undefined)?.type === "disabled";
      expect(disabled && "reasoning_effort" in options).toBe(false);
    }
  });
});
