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

describe("computerPluginsOf", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    adapterLoads.count = 0;
  });

  it("offers no Computer plugin and does not load the E2B adapter when E2B is unset", async () => {
    // Re-evaluates the module, so a static import of the adapter would count as a load here.
    const { computerPluginsOf } = await import("./computer");
    expect(await computerPluginsOf(undefined, "ai-chat-computer-v2")).toEqual([]);
    expect(adapterLoads.count).toBe(0);
    expect(e2bProvider).not.toHaveBeenCalled();
  });

  it("loads the E2B adapter and offers the Computer plugin when E2B is set", async () => {
    const { computerPluginsOf } = await import("./computer");
    const plugins = await computerPluginsOf(e2b, "ai-chat-computer-v2");
    expect(adapterLoads.count).toBe(1);
    expect(e2bProvider).toHaveBeenCalledWith({ ...e2b, template: "ai-chat-computer-v2" });
    expect(plugins).toHaveLength(1);
  });
});
