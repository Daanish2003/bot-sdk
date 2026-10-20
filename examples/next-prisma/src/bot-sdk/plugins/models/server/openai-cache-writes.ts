import { type AnyTextAdapter, EventType } from "@tanstack/ai";

/**
 * OpenAI's text adapter, with the input tokens each call wrote to the prompt cache in its usage
 * (#667). `@tanstack/ai-openai` reads only `cached_tokens` from the Responses usage and drops
 * `cache_write_tokens`, so the `fetch` given to `create` reads it from the raw `response.completed`
 * event (passing the stream on unchanged), and the call's `RUN_FINISHED` usage gets it as
 * `promptTokensDetails.cacheWriteTokens`. `base` is the `fetch` underneath: the plan's on a linked
 * ChatGPT plan, else the global one.
 *
 * The adapter runs one call at a time, as every caller's does: a call's writes are the last
 * `response.completed` seen during it.
 */
export function withOpenaiCacheWrites(
  create: (fetch: typeof globalThis.fetch) => AnyTextAdapter,
  base: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init),
): AnyTextAdapter {
  let written: number | undefined;
  const adapter = create(async (input, init) => {
    const response = await base(input, init);
    if (!response.ok || !response.body) return response;
    const read = readCacheWrites((tokens) => {
      written = tokens;
    });
    return new Response(response.body.pipeThrough(read), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });
  const chatStream = adapter.chatStream.bind(adapter);
  adapter.chatStream = async function* (options) {
    written = undefined;
    for await (const chunk of chatStream(options)) {
      const usage = chunk.type === EventType.RUN_FINISHED ? chunk.usage : undefined;
      if (!usage || Array.isArray(usage) || !written) {
        yield chunk;
        continue;
      }
      const promptTokensDetails = { ...usage.promptTokensDetails, cacheWriteTokens: written };
      yield { ...chunk, usage: { ...usage, promptTokensDetails } };
    }
  };
  return adapter;
}

/**
 * Passes the server-sent events on as they came, and calls `onWrite` with the
 * `usage.input_tokens_details.cache_write_tokens` of a `response.completed` event.
 */
function readCacheWrites(onWrite: (tokens: number) => void): TransformStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  const read = (event: string) => {
    if (!event.includes("response.completed")) return;
    const line = event.split("\n").find((entry) => entry.startsWith("data:"));
    if (!line) return;
    let data: {
      type?: string;
      response?: { usage?: { input_tokens_details?: { cache_write_tokens?: unknown } } };
    };
    try {
      data = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    const tokens = data.response?.usage?.input_tokens_details?.cache_write_tokens;
    if (data.type === "response.completed" && typeof tokens === "number") onWrite(tokens);
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      // Normalized on the whole buffer: a "\r\n" can be split across two chunks.
      buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        read(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    },
    flush() {
      buffer += decoder.decode();
      if (buffer) read(buffer);
    },
  });
}
