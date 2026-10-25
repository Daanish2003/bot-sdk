import { beforeEach, describe, expect, it, vi } from "vitest";

const { adapterLoads, e2bProvider } = vi.hoisted(() => ({
  adapterLoads: { count: 0 },
  e2bProvider: vi.fn(() => ({ kind: "e2b-provider" })),
}));

vi.mock("@ai-chat/bot-sdk/plugins/computer/e2b", () => {
  adapterLoads.count += 1;
  return { e2bProvider };
});

const e2b = {
  apiKey: "key",
  apiUrl: "http://localhost:3000",
  sandboxUrl: "http://localhost:3002",
};

describe("computerProviderOf", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    adapterLoads.count = 0;
  });

  it("offers no Computer provider and does not load the E2B adapter when E2B is unset", async () => {
    // Re-evaluates the module, so a static import of the adapter would count as a load here.
    const { computerProviderOf } = await import("./computer");
    expect(await computerProviderOf(undefined, "ai-chat-computer-v3")).toBeUndefined();
    expect(adapterLoads.count).toBe(0);
    expect(e2bProvider).not.toHaveBeenCalled();
  });

  it("loads the E2B adapter and offers its Computer provider when E2B is set", async () => {
    const { computerProviderOf } = await import("./computer");
    const provider = await computerProviderOf(e2b, "ai-chat-computer-v3");
    expect(adapterLoads.count).toBe(1);
    expect(e2bProvider).toHaveBeenCalledWith({ ...e2b, template: "ai-chat-computer-v3" });
    expect(provider).toEqual({ kind: "e2b-provider" });
  });
});

describe("e2bConfigOf", () => {
  it("is none when E2B is unset, the config when all three are set, and fails on a partial config", async () => {
    const { e2bConfigOf } = await import("./computer");
    expect(e2bConfigOf({})).toBeUndefined();
    expect(
      e2bConfigOf({
        E2B_API_KEY: e2b.apiKey,
        E2B_API_URL: e2b.apiUrl,
        E2B_SANDBOX_URL: e2b.sandboxUrl,
      }),
    ).toEqual(e2b);
    expect(() => e2bConfigOf({ E2B_API_KEY: e2b.apiKey })).toThrow(/set together or not at all/);
  });
});
