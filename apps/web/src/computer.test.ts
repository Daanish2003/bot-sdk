import { beforeEach, describe, expect, it, vi } from "vitest";

import { computerPluginsOf } from "./computer";

const { e2bModuleLoaded, e2bProvider } = vi.hoisted(() => ({
  e2bModuleLoaded: vi.fn(),
  e2bProvider: vi.fn(() => ({ kind: "e2b-provider" })),
}));

vi.mock("@ai-chat/bot-sdk/plugins/computer/e2b", () => {
  e2bModuleLoaded();
  return { e2bProvider };
});

const e2b = {
  apiKey: "key",
  apiUrl: "http://localhost:3000",
  sandboxUrl: "http://localhost:3002",
};

describe("computerPluginsOf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers no Computer plugin and does not load the E2B adapter when E2B is unset", async () => {
    expect(await computerPluginsOf(undefined, "ai-chat-computer-v1")).toEqual([]);
    expect(e2bModuleLoaded).not.toHaveBeenCalled();
    expect(e2bProvider).not.toHaveBeenCalled();
  });

  it("loads the E2B adapter and offers the Computer plugin when E2B is set", async () => {
    const plugins = await computerPluginsOf(e2b, "ai-chat-computer-v1");
    expect(e2bModuleLoaded).toHaveBeenCalledOnce();
    expect(e2bProvider).toHaveBeenCalledWith({ ...e2b, template: "ai-chat-computer-v1" });
    expect(plugins).toHaveLength(1);
  });
});
