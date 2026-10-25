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
