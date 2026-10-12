import { findModel, unknownReasoning } from "../../../core/shared/chat/models";
import { describe, expect, it } from "vitest";

import { missingCredentialsMessage, modelGroups, modelLabel } from "../../../core/client/models";

const available = [
  "openai:gpt-5.6",
  "anthropic:claude-sonnet-5-5",
  "anthropic:claude-haiku-4-5",
  "openai:gpt-5.4-mini",
].map((id) => findModel(id)!);

describe("modelGroups", () => {
  it("groups the Models by Provider, in Provider order", () => {
    const groups = modelGroups(available, "");

    expect(groups.map((group) => [group.label, group.models.map((model) => model.id)])).toEqual([
      ["Anthropic", ["anthropic:claude-sonnet-5-5", "anthropic:claude-haiku-4-5"]],
      ["OpenAI", ["openai:gpt-5.6", "openai:gpt-5.4-mini"]],
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

describe("missingCredentialsMessage", () => {
  it("is null while the selected Model's Provider has credentials", () => {
    expect(missingCredentialsMessage("openai:gpt-5.6", available, true)).toBeNull();
  });

  it("asks for the Provider's key when its credentials are gone", () => {
    expect(missingCredentialsMessage("openai:gpt-6-luna", available.slice(1, 3), true)).toBe(
      "Add an OpenAI key or pick another Model",
    );
    expect(missingCredentialsMessage("anthropic:claude-opus-5-5", [], true)).toBe(
      "Add an Anthropic key or pick another Model",
    );
  });

  it("asks for the key of a live-listed Model's Provider when its credentials are gone", () => {
    expect(missingCredentialsMessage("openrouter:openai/gpt-5.5", available, true)).toBe(
      "Add an OpenRouter key or pick another Model",
    );
  });

  it("asks for another Model when a live-listed Model left its list", () => {
    expect(
      missingCredentialsMessage("ollama:llama3.2:latest", [liveModel("ollama", "qwen3:8b")], true),
    ).toBe("Pick another Model");
  });

  it("asks for another Model when the selected one isn't offered any more", () => {
    expect(missingCredentialsMessage("openai:gpt-2", available, true)).toBe("Pick another Model");
  });
});

describe("modelLabel", () => {
  it("is the curated label of a curated Model", () => {
    expect(modelLabel("anthropic:claude-haiku-4-5")).toBe(
      findModel("anthropic:claude-haiku-4-5")!.label,
    );
  });

  it("is the id without its Provider for a live-listed Model", () => {
    expect(modelLabel("ollama:llama3.2:3b")).toBe("llama3.2:3b");
  });

  it("is the id itself when it has no Provider", () => {
    expect(modelLabel("mystery")).toBe("mystery");
  });
});

describe("missingCredentialsMessage with byok off", () => {
  it("asks for another Model, never for a key, when the Provider has none", () => {
    expect(missingCredentialsMessage("openai:gpt-6-luna", available.slice(1, 3), false)).toBe(
      "Pick another Model",
    );
  });
});
