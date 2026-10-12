import { describe, expect, it } from "vitest";

import { hostBackgroundModelOf, hostProvidersOf, quotaOf } from "./host-models";

const model = {
  modelId: "e2e-model",
  maxOutputTokens: 1024,
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 5,
};

const hostEnv = {
  HOST_PROVIDER: "ollama",
  HOST_CREDENTIALS: JSON.stringify({ host: "http://localhost:11434" }),
  HOST_MODELS: JSON.stringify([model]),
};

describe("hostProvidersOf", () => {
  it("offers no Host credentials when none are set", () => {
    expect(hostProvidersOf({})).toEqual([]);
    expect(
      hostProvidersOf({ HOST_PROVIDER: "", HOST_CREDENTIALS: " ", HOST_MODELS: undefined }),
    ).toEqual([]);
  });

  it("maps the three variables to one Host Provider", () => {
    expect(hostProvidersOf(hostEnv)).toEqual([
      {
        provider: "ollama",
        credentials: { host: "http://localhost:11434" },
        models: [model],
      },
    ]);
  });

  it("refuses a partial set, since a Host Model needs its credentials and its price", () => {
    expect(() => hostProvidersOf({ HOST_PROVIDER: "ollama" })).toThrow(
      /HOST_PROVIDER, HOST_CREDENTIALS and HOST_MODELS/,
    );
    expect(() => hostProvidersOf({ ...hostEnv, HOST_MODELS: undefined })).toThrow(
      /HOST_PROVIDER, HOST_CREDENTIALS and HOST_MODELS/,
    );
  });

  it("refuses credentials that are not a JSON object of strings", () => {
    expect(() => hostProvidersOf({ ...hostEnv, HOST_CREDENTIALS: "not json" })).toThrow();
    expect(() => hostProvidersOf({ ...hostEnv, HOST_CREDENTIALS: '["a"]' })).toThrow();
  });

  it("refuses a Model without a Host output cap or a price", () => {
    const { maxOutputTokens: _omitted, ...withoutCap } = model;
    expect(() =>
      hostProvidersOf({ ...hostEnv, HOST_MODELS: JSON.stringify([withoutCap]) }),
    ).toThrow();
    expect(() =>
      hostProvidersOf({
        ...hostEnv,
        HOST_MODELS: JSON.stringify([{ ...model, inputUsdPerMillion: undefined }]),
      }),
    ).toThrow();
  });

  it("refuses an empty Model list", () => {
    expect(() => hostProvidersOf({ ...hostEnv, HOST_MODELS: "[]" })).toThrow();
  });
});

describe("hostBackgroundModelOf", () => {
  it("is unset when HOST_BACKGROUND_MODEL is not set", () => {
    expect(hostBackgroundModelOf(hostEnv)).toBeUndefined();
    expect(hostBackgroundModelOf({ ...hostEnv, HOST_BACKGROUND_MODEL: " " })).toBeUndefined();
  });

  it("is the id of one of the Host's Models", () => {
    expect(hostBackgroundModelOf({ ...hostEnv, HOST_BACKGROUND_MODEL: "ollama:e2e-model" })).toBe(
      "ollama:e2e-model",
    );
  });

  it("refuses an id that is not one of the Host's Models", () => {
    expect(() =>
      hostBackgroundModelOf({ ...hostEnv, HOST_BACKGROUND_MODEL: "ollama:other" }),
    ).toThrow(/HOST_BACKGROUND_MODEL/);
    expect(() => hostBackgroundModelOf({ HOST_BACKGROUND_MODEL: "ollama:e2e-model" })).toThrow(
      /HOST_BACKGROUND_MODEL/,
    );
  });
});

describe("quotaOf", () => {
  it("is unlimited when no budget is set", () => {
    expect(quotaOf({})).toBeUndefined();
    expect(quotaOf({ HOST_QUOTA_BUDGET_USD: " ", HOST_QUOTA_WINDOW: "month" })).toBeUndefined();
  });

  it("is one fixed Quota for everyone, by the day unless the window says month", () => {
    expect(quotaOf({ HOST_QUOTA_BUDGET_USD: "0.5" })).toEqual({ budgetUsd: 0.5, window: "day" });
    expect(quotaOf({ HOST_QUOTA_BUDGET_USD: "2", HOST_QUOTA_WINDOW: "month" })).toEqual({
      budgetUsd: 2,
      window: "month",
    });
  });

  it.each(["0", "-1", "lots", "NaN"])("refuses the budget %s", (budget) => {
    expect(() => quotaOf({ HOST_QUOTA_BUDGET_USD: budget })).toThrow(/HOST_QUOTA_BUDGET_USD/);
  });

  it("refuses an unknown window", () => {
    expect(() => quotaOf({ HOST_QUOTA_BUDGET_USD: "1", HOST_QUOTA_WINDOW: "week" })).toThrow(
      /HOST_QUOTA_WINDOW/,
    );
  });
});
