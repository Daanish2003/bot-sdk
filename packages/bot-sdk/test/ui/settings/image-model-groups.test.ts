import { describe, expect, it } from "vitest";

import type { ListedImageModel } from "../../../core/shared/chat/image-models";
import { groupImageModels } from "../../../ui/settings/image-model-groups";

function model(provider: string, modelId: string, onHostCredentials: boolean): ListedImageModel {
  return {
    id: `${provider}:${modelId}`,
    provider,
    modelId,
    label: modelId,
    maxInputImages: 0,
    onHostCredentials,
  } as ListedImageModel;
}

describe("groupImageModels", () => {
  it("lists the groups on the user's own credentials before the Host's, each in Provider order", () => {
    const groups = groupImageModels([
      model("openai", "gpt-image-2", true),
      model("gemini", "gemini-3.1-flash-image", false),
      model("openrouter", "google/gemini-3.1-flash-image", true),
      model("grok", "grok-imagine-image", false),
    ]);

    expect(groups.map((group) => group.provider)).toEqual([
      "gemini",
      "grok",
      "openai",
      "openrouter",
    ]);
    expect(groups.map((group) => group.models.map((m) => m.onHostCredentials))).toEqual([
      [false],
      [false],
      [true],
      [true],
    ]);
  });

  it("labels each group with its Provider name and keeps a group's models together", () => {
    const groups = groupImageModels([
      model("openai", "gpt-image-2", false),
      model("openai", "dall-e-3", false),
    ]);

    expect(groups).toEqual([
      {
        provider: "openai",
        label: "OpenAI",
        models: [model("openai", "gpt-image-2", false), model("openai", "dall-e-3", false)],
      },
    ]);
  });

  it("returns no groups when there are no Image Models", () => {
    expect(groupImageModels([])).toEqual([]);
  });
});
