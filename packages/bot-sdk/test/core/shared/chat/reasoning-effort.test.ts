import { describe, expect, it } from "vitest";

import {
  effortFor,
  reasoningChoices,
  type ReasoningSupport,
} from "../../../../core/shared/chat/models";

const withEfforts: ReasoningSupport = {
  efforts: ["low", "medium", "high"],
  off: true,
  defaultEffort: null,
};

describe("reasoningChoices", () => {
  it("offers off where the Model allows it, then its efforts", () => {
    expect(reasoningChoices({ provider: "openai", reasoning: withEfforts })).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  it("leaves off out where the Model doesn't allow turning reasoning off", () => {
    const reasoning = { ...withEfforts, off: false };
    expect(reasoningChoices({ provider: "anthropic", reasoning })).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("offers nothing for a Model that doesn't reason", () => {
    const reasoning = { efforts: [], off: false, defaultEffort: null };
    expect(reasoningChoices({ provider: "anthropic", reasoning })).toEqual([]);
  });

  it.each(["mistral", "bedrock", "ollama"])(
    "offers nothing on %s, whose adapters take no reasoning setting",
    (provider) => {
      expect(reasoningChoices({ provider, reasoning: withEfforts })).toEqual([]);
    },
  );
});

describe("effortFor", () => {
  const model = { provider: "openai", reasoning: withEfforts };

  it("sends no effort when the Conversation has no choice: the Model's default", () => {
    expect(effortFor(model, null)).toBeUndefined();
  });

  it("sends the Conversation's choice when the Model offers it", () => {
    expect(effortFor(model, "high")).toBe("high");
    expect(effortFor(model, "off")).toBe("off");
  });

  it("sends no effort when the Model doesn't offer the stored choice", () => {
    const low: { provider: string; reasoning: ReasoningSupport } = {
      provider: "anthropic",
      reasoning: { ...withEfforts, off: false, efforts: ["low"] },
    };
    expect(effortFor(low, "high")).toBeUndefined();
    expect(effortFor(low, "off")).toBeUndefined();
  });
});
