import { type AdapterYieldChunk, type AnyTextAdapter, EventType } from "@tanstack/ai";

/** What a call on a broken ChatGPT link fails with (ADR 0023). */
export const reconnectChatgptMessage = "Reconnect ChatGPT on the Keys page";
/** The error code of that failure: a Provider error, not a rejected API key. */
const reconnectChatgptCode = "chatgpt_reconnect";

/**
 * The `fetch` the OpenAI adapter uses on a linked ChatGPT plan (the #639 probe). The plan's route
 * differs from the API key's in three ways, each fixed here so the adapter stays as it is:
 *
 * - it refuses a request without `store: false`, so the body sets it;
 * - its Models refuse reasoning effort `none` (the chat's "off"), so `none` is sent as `low`;
 * - its stream is "lite": `response.completed` has an empty `output`, so the adapter would never
 *   see a tool call. The items the stream sent (`response.output_item.done`) are put back in.
 *
 * A rejected token (401) means a broken link, so its message asks to reconnect; a 403 keeps
 * OpenAI's own message. The plan's
 * stream has no content-type, so nothing here branches on it.
 */
export function chatgptPlanFetch(
  base: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  return async (input, init) => {
    const response = await base(input, withPlanBody(init));
    if (response.status === 401) return reconnectResponse(response);
    if (!response.ok || !response.body) return response;
    return new Response(response.body.pipeThrough(fillCompletedOutput()), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** The request with `store: false`, and effort `none` as `low`. A body that isn't JSON is left alone. */
function withPlanBody(init: RequestInit | undefined): RequestInit | undefined {
  if (typeof init?.body !== "string") return init;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(init.body);
  } catch {
    return init;
  }
  body.store = false;
  const reasoning = body.reasoning as { effort?: string } | undefined;
  if (reasoning?.effort === "none") body.reasoning = { ...reasoning, effort: "low" };
  return { ...init, body: JSON.stringify(body) };
}

/** A 401 with the reconnect message, keeping its status; the code marks it as a broken link. */
async function reconnectResponse(response: Response): Promise<Response> {
  await response.body?.cancel();
  return new Response(
    JSON.stringify({
      error: {
        message: reconnectChatgptMessage,
        type: "invalid_request_error",
        code: reconnectChatgptCode,
      },
    }),
    { status: response.status, headers: { "content-type": "application/json" } },
  );
}

/**
 * Rewrites the server-sent events so an empty `response.completed.output` holds the items the
 * stream already sent, in their output order.
 */
function fillCompletedOutput(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const items: unknown[] = [];
  let buffer = "";
  const rewrite = (event: string): string => {
    const line = event.split("\n").find((entry) => entry.startsWith("data:"));
    if (!line) return event;
    let data: {
      type?: string;
      output_index?: number;
      item?: unknown;
      response?: { output?: unknown[] };
    };
    try {
      data = JSON.parse(line.slice(5));
    } catch {
      return event;
    }
    if (data.type === "response.output_item.done") {
      items[data.output_index ?? items.length] = data.item;
    }
    if (
      data.type === "response.completed" &&
      data.response &&
      (data.response.output ?? []).length === 0 &&
      items.length > 0
    ) {
      data.response.output = items.filter(Boolean);
      return event.replace(line, `data: ${JSON.stringify(data)}`);
    }
    return event;
  };
  return new TransformStream({
    transform(chunk, controller) {
      // Normalized on the whole buffer: a "\r\n" can be split across two chunks.
      buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        controller.enqueue(encoder.encode(`${rewrite(buffer.slice(0, end))}\n\n`));
        buffer = buffer.slice(end + 2);
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
    },
  });
}

/**
 * The adapter of a call whose ChatGPT link is broken (ADR 0023): every call fails asking the user to
 * reconnect, so the Run fails rather than falling back to Host credentials.
 */
export function reconnectChatgptAdapter(model: string): AnyTextAdapter {
  const fail = (): AdapterYieldChunk => ({
    type: EventType.RUN_ERROR,
    message: reconnectChatgptMessage,
    code: reconnectChatgptCode,
    error: { message: reconnectChatgptMessage, code: reconnectChatgptCode },
    timestamp: Date.now(),
  });
  return {
    kind: "text",
    name: "openai",
    model,
    "~types": {
      providerOptions: {},
      inputModalities: ["text"],
      messageMetadataByModality: {
        text: undefined,
        image: undefined,
        audio: undefined,
        video: undefined,
        document: undefined,
      },
      toolCapabilities: [],
      toolCallMetadata: undefined,
      systemPromptMetadata: undefined as never,
    },
    async *chatStream() {
      yield fail();
    },
    structuredOutput: async () => {
      throw new Error(reconnectChatgptMessage);
    },
  };
}
