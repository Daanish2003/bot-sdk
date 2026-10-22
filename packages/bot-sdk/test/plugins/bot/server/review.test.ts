import { describe, expect, it, vi } from "vitest";

import type { BotSdkContext } from "../../../../core/server/plugin";
import { type ReviewKit, reviewToolCall } from "../../../../plugins/bot/server/review";

describe("a review's replay", () => {
  it("reads its recorded verdict and write without resolving the review Model's meter", async () => {
    const resolveModelCall = vi.fn(async () => null);
    const publish = vi.fn(async () => {});
    const deps = {
      pubsub: { publish },
      plugin: (name: string) =>
        name === "models"
          ? { resolveModelCall, freeModelMeter: vi.fn() }
          : { reviewModel: undefined },
    } as unknown as BotSdkContext;
    // Every activity was recorded: a replay returns what it saved.
    const recorded: Record<string, unknown> = {
      review: {
        outcome: "pass",
        reason: "The user asked for it.",
        summary: "List the files",
        model: "openai:gpt-5.6",
        bill: { usage: { inputTokens: 10, outputTokens: 2 } },
      },
      "review:write": "0199f000-0000-7000-8000-000000000001",
    };
    const replay = async (name: string) => recorded[name];
    const kit = {
      activity: replay,
      billing: replay,
      now: async () => new Date("2030-01-01T00:00:00Z"),
      beforeLive: () => {},
      signal: new AbortController().signal,
      usageOf: () => null,
    } as unknown as ReviewKit;

    const blocked = await reviewToolCall(deps, kit, {
      owner: { userId: "u1", botId: "b1", model: "openai:gpt-5.6" },
      source: { turnId: "t1", conversationId: "c1" },
      toolCallId: "call-1",
      tool: "shell",
      input: { command: "ls" },
    });

    expect(blocked).toBeNull();
    expect(resolveModelCall).not.toHaveBeenCalled();
    // A replay writes nothing new, so it hints no change.
    expect(publish).not.toHaveBeenCalled();
  });
});
