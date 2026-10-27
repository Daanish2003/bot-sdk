import { describe, expect, it, vi } from "vitest";

import type { BotSdkContext } from "@botsdk/bot/plugin";
import { hintChanged } from "@botsdk/bot/bot/conversation";

describe("hintChanged", () => {
  it("logs a failed publish and never throws: the change log holds the change anyway", async () => {
    const error = vi.fn();
    const deps = {
      pubsub: { publish: vi.fn(async () => Promise.reject(new Error("Redis is down"))) },
      logger: { error },
    } as unknown as BotSdkContext;

    await expect(hintChanged(deps, "c1")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });
});
