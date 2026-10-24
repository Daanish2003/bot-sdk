import { EventType, type StreamChunk } from "@tanstack/ai";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { describe, expect, it } from "vitest";

const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 105,
};

/** A recorded Responses stream that answers "Hi" and completes with `completedUsage`. */
function recordedStream(completedUsage: unknown): string {
  const response = { id: "resp_1", object: "response", model: "gpt-6-luna", status: "in_progress" };
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Hi", annotations: [] }],
  };
  return [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hi" },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: { ...response, status: "completed", output: [message], usage: completedUsage },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

/** OpenAI's adapter through the wrapper, on a base `fetch` that answers `body`. */
function adapterAnswering(body: string) {
  const base: typeof fetch = async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  const adapter = createOpenaiChat("gpt-6-luna", "sk-test", { fetch: base });
  return { adapter };
}

async function chunksOf(adapter: ReturnType<typeof adapterAnswering>["adapter"]) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.chatStream({
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "Hello" }],
    // The engine passes its logger; a call that fails throws instead of being logged.
    logger: new Proxy(
      {},
      {
        get:
          (_target, level) =>
          (...args: unknown[]) => {
            if (level === "errors") throw new Error(JSON.stringify(args));
          },
      },
    ),
  } as never)) {
    chunks.push(chunk);
  }
  return chunks;
}

const finishedUsage = (chunks: StreamChunk[]) =>
  chunks.find((chunk) => chunk.type === EventType.RUN_FINISHED)?.usage;

describe("OpenAI's adapter", () => {
  it("surfaces cache_write_tokens from response.completed in the call's usage", async () => {
    const { adapter } = adapterAnswering(recordedStream(usage));

    const chunks = await chunksOf(adapter);

    expect(finishedUsage(chunks)).toMatchObject({
      promptTokens: 100,
      completionTokens: 5,
      promptTokensDetails: { cachedTokens: 40, cacheWriteTokens: 60 },
    });
    expect(
      chunks
        .filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((chunk) => (chunk as { delta: string }).delta)
        .join(""),
    ).toBe("Hi");
  });

  it("leaves a call that wrote nothing to the cache as the adapter reported it", async () => {
    const { input_tokens_details: _details, ...withoutDetails } = usage;
    const { adapter } = adapterAnswering(recordedStream(withoutDetails));

    const chunks = await chunksOf(adapter);

    expect(finishedUsage(chunks)).not.toHaveProperty("promptTokensDetails");
  });

  it("doesn't carry one call's cache writes into the next", async () => {
    const bodies = [
      recordedStream(usage),
      recordedStream({ ...usage, input_tokens_details: { cached_tokens: 0 } }),
    ];
    const adapter = createOpenaiChat("gpt-6-luna", "sk-test", {
      fetch: async () => new Response(bodies.shift(), { status: 200 }),
    });

    await chunksOf(adapter);
    const second = await chunksOf(adapter);

    expect(finishedUsage(second)).not.toHaveProperty("promptTokensDetails.cacheWriteTokens");
  });
});
