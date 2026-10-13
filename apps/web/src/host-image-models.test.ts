import { describe, expect, it } from "vitest";

import { hostDefaultImageModelOf, hostImageProvidersOf } from "./host-models";

const imageModel = {
  modelId: "gpt-image-1-mini",
  size: "1024x1024",
  quality: "medium",
  pricePerImageUsd: 0.01,
};

const hostImageEnv = {
  HOST_IMAGE_PROVIDER: "openai",
  HOST_IMAGE_CREDENTIALS: JSON.stringify({ apiKey: "host-key" }),
  HOST_IMAGE_MODELS: JSON.stringify([imageModel]),
};

describe("hostImageProvidersOf", () => {
  it("offers no Host Image Models when none are set", () => {
    expect(hostImageProvidersOf({})).toEqual([]);
    expect(
      hostImageProvidersOf({
        HOST_IMAGE_PROVIDER: " ",
        HOST_IMAGE_CREDENTIALS: "",
        HOST_IMAGE_MODELS: undefined,
      }),
    ).toEqual([]);
  });

  it("maps the three variables to one Provider entry with no chat Models", () => {
    expect(hostImageProvidersOf(hostImageEnv)).toEqual([
      {
        provider: "openai",
        credentials: { apiKey: "host-key" },
        models: [],
        imageModels: [imageModel],
      },
    ]);
  });

  it("refuses a partial set", () => {
    expect(() => hostImageProvidersOf({ HOST_IMAGE_PROVIDER: "openai" })).toThrow(
      /HOST_IMAGE_PROVIDER, HOST_IMAGE_CREDENTIALS and HOST_IMAGE_MODELS/,
    );
  });

  it("refuses an Image Model without a size, quality or price", () => {
    const withoutSize = { ...imageModel, size: undefined };
    const withoutQuality = { ...imageModel, quality: undefined };
    const withoutPrice = { ...imageModel, pricePerImageUsd: undefined };
    for (const model of [withoutSize, withoutQuality, withoutPrice]) {
      expect(() =>
        hostImageProvidersOf({ ...hostImageEnv, HOST_IMAGE_MODELS: JSON.stringify([model]) }),
      ).toThrow();
    }
  });

  it("refuses an empty Image Model list", () => {
    expect(() => hostImageProvidersOf({ ...hostImageEnv, HOST_IMAGE_MODELS: "[]" })).toThrow();
  });
});

describe("hostDefaultImageModelOf", () => {
  it("is unset when HOST_DEFAULT_IMAGE_MODEL is not set", () => {
    expect(hostDefaultImageModelOf(hostImageEnv)).toBeUndefined();
  });

  it("is the id of one of the Host's Image Models", () => {
    expect(
      hostDefaultImageModelOf({
        ...hostImageEnv,
        HOST_DEFAULT_IMAGE_MODEL: "openai:gpt-image-1-mini",
      }),
    ).toBe("openai:gpt-image-1-mini");
  });

  it("refuses an id that is not one of the Host's Image Models", () => {
    expect(() =>
      hostDefaultImageModelOf({ ...hostImageEnv, HOST_DEFAULT_IMAGE_MODEL: "openai:other" }),
    ).toThrow(/HOST_DEFAULT_IMAGE_MODEL/);
    expect(() =>
      hostDefaultImageModelOf({ HOST_DEFAULT_IMAGE_MODEL: "openai:gpt-image-1-mini" }),
    ).toThrow(/HOST_DEFAULT_IMAGE_MODEL/);
  });
});
