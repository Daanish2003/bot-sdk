import { chat } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { describe, expect, it } from "vitest";

import { reportedUsageOf } from "../../../../plugins/models/server/internal";

/** An Anthropic Messages stream that read 800 tokens from the cache and wrote 100, past 100 uncached. */
function anthropicStream(): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 100,
          output_tokens: 1,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi." } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 50 },
    },
    { type: "message_stop" },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  return new Response(body.join(""), { headers: { "content-type": "text/event-stream" } });
}

describe("reportedUsageOf", () => {
  // Pins what TanStack AI 1.0's Anthropic adapter reports: input with its cache reads and writes.
  it("counts an Anthropic call's cache reads and writes once in its input", async () => {
    const adapter = createAnthropicChat("claude-sonnet-5-5", "sk-test", {
      fetch: async () => anthropicStream(),
    });

    const chunks = [];
    for await (const chunk of chat({
      threadId: "test-thread",
      adapter,
      messages: [{ role: "user", content: "Hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(reportedUsageOf(chunks).usage).toEqual({
      input: 1000,
      output: 50,
      reasoning: 0,
      cached: 800,
      cacheWrite: 100,
    });
  });
});
