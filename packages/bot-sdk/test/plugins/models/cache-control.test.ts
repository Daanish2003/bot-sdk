import type { TextOptions } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { describe, expect, it } from "vitest";

import { withCacheControl } from "@botsdk/bot/models/internal";

const options = (): TextOptions =>
  ({
    model: "m",
    messages: [
      { role: "user", content: "[Your environment] ..." },
      { role: "user", content: "Hello" },
    ],
    systemPrompts: ["You are Ada.", "Memory: off."],
    logger: { errors: () => {}, request: () => {}, provider: () => {} },
  }) as unknown as TextOptions;

const oneHour = { type: "ephemeral", ttl: "1h" };

describe("withCacheControl", () => {
  it("puts 1-hour breakpoints on the last system block, the first message and the request, in Anthropic's body", () => {
    // The adapter builds its request body in a private method; the body is what the wire carries.
    const adapter = createAnthropicChat("claude-sonnet-5-5", "sk-ant-test") as unknown as {
      mapCommonOptionsToAnthropic: (options: TextOptions) => Record<string, any>;
    };

    const body = adapter.mapCommonOptionsToAnthropic(
      withCacheControl("anthropic", "bot:b1", options()),
    );

    expect(body.cache_control).toEqual(oneHour);
    expect(body.system).toEqual([
      { type: "text", text: "You are Ada." },
      { type: "text", text: "Memory: off.", cache_control: oneHour },
    ]);
    expect(body.messages[0]).toEqual({
      role: "user",
      // Anthropic merges the two user messages; only the first block carries the breakpoint.
      content: [
        { type: "text", text: "[Your environment] ...", cache_control: oneHour },
        { type: "text", text: "Hello" },
      ],
    });
  });

  it("keeps the generation settings beside Anthropic's automatic breakpoint", () => {
    const sent = withCacheControl("anthropic", "bot:b1", {
      ...options(),
      modelOptions: { temperature: 0.2 },
    });

    expect(sent.modelOptions).toEqual({ temperature: 0.2, cache_control: oneHour });
  });

  it("sends OpenAI's prompt_cache_key and no retention", () => {
    const adapter = createOpenaiChat("gpt-6-luna", "sk-test") as unknown as {
      mapOptionsToRequest: (options: TextOptions) => Record<string, unknown>;
    };

    const body = adapter.mapOptionsToRequest(withCacheControl("openai", "helper:h1", options()));

    expect(body.prompt_cache_key).toBe("helper:h1");
    expect(body).not.toHaveProperty("prompt_cache_retention");
    expect(body).not.toHaveProperty("prompt_cache_options");
  });

  it("adds nothing for Gemini or any other Provider", () => {
    const before = options();

    expect(withCacheControl("gemini", "bot:b1", before)).toEqual(before);
    expect(withCacheControl("groq", "bot:b1", before)).toEqual(before);
  });
});
