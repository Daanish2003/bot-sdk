import { findModel, unknownReasoning } from "../../../plugins/models/shared/models";
import { describe, expect, it } from "vitest";

import { modelGroups } from "../../../plugins/models/client/models";

const available = [
  "openai:gpt-6-luna",
  "anthropic:claude-sonnet-5-5",
  "anthropic:claude-haiku-4-5",
  "openai:gpt-5.4-mini",
].map((id) => findModel(id)!);

describe("modelGroups", () => {
  it("groups the Models by Provider, in Provider order", () => {
    const groups = modelGroups(available, "");

    expect(groups.map((group) => [group.label, group.models.map((model) => model.id)])).toEqual([
      ["Anthropic", ["anthropic:claude-sonnet-5-5", "anthropic:claude-haiku-4-5"]],
      ["OpenAI", ["openai:gpt-6-luna", "openai:gpt-5.4-mini"]],
    ]);
  });

  it("filters by the search text, ignoring case, and drops Providers left empty", () => {
    const groups = modelGroups(available, "  MINI ");

    expect(groups).toEqual([
      {
        provider: "openai",
        label: "OpenAI",
        live: false,
        models: [findModel("openai:gpt-5.4-mini")],
      },
    ]);
  });

  it("matches the Provider name too", () => {
    const groups = modelGroups(available, "anthro");

    expect(groups.map((group) => group.provider)).toEqual(["anthropic"]);
    expect(groups[0]!.models).toHaveLength(2);
  });
});

const liveModel = (provider: "openrouter" | "ollama", modelId: string) => ({
  id: `${provider}:${modelId}`,
  provider,
  modelId,
  label: modelId,
  images: false,
  pdfs: false,
  tools: true,
  computerUse: false,
  contextWindow: null,
  maxOutputTokens: null,
  reasoning: unknownReasoning(),
});

describe("modelGroups with live lists", () => {
  it("labels the OpenRouter and Ollama groups as live lists", () => {
    const groups = modelGroups(
      [...available, liveModel("ollama", "qwen3:8b"), liveModel("openrouter", "openai/gpt-5.5")],
      "",
    );

    expect(groups.map((group) => [group.provider, group.live])).toEqual([
      ["anthropic", false],
      ["openai", false],
      ["openrouter", true],
      ["ollama", true],
    ]);
  });
});
