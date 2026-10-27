import { type AdapterYieldChunk, type AnyTextAdapter, EventType } from "@tanstack/ai";

import { reconnectChatgptMessage } from "./shared/chatgpt-plan";

/** The error code of that failure: a Provider error, not a rejected API key. */
const reconnectChatgptCode = "chatgpt_reconnect";

/**
 * The `fetch` the OpenAI adapter uses on a linked ChatGPT plan (the #639 probe). The plan's route
 * differs from the API key's in two ways, each fixed here so the adapter stays as it is:
 *
 * - it refuses a request without `store: false`, so the body sets it;
 * - its Models refuse reasoning effort `none` (the chat's "off"), so `none` is sent as `low`.
 *
 * A rejected token (401) means a broken link, so its message asks to reconnect; a 403 keeps
 * OpenAI's own message, and so do a 403 and a 429 (see {@link planErrorResponse}). The plan's
 * stream has no content-type, so nothing here branches on it.
 */
export function chatgptPlanFetch(
  base: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  return async (input, init) => {
    const response = await base(input, withPlanBody(init));
    if (response.status === 401) return reconnectResponse(response);
    if (response.status === 429) return planErrorResponse(response, "chatgpt_plan_rate_limited");
    if (response.status === 403) return planErrorResponse(response, "chatgpt_plan_forbidden");
    return response;
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

/**
 * A 403 or 429 from the plan with a code of its own, so the Run is stored as a Provider error that
 * quotes OpenAI's message ("You've hit your usage limit") instead of the generic rate-limit text, or,
 * for a user with no API key, "The Provider rejected your API key". A body that isn't JSON with an
 * `error` object is passed on as it came.
 */
async function planErrorResponse(response: Response, code: string): Promise<Response> {
  const text = await response.text();
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  try {
    const body = JSON.parse(text) as { error?: Record<string, unknown> };
    if (body.error && typeof body.error === "object") {
      body.error.code = code;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify(body), { ...init, headers });
    }
  } catch {
    // Not JSON: nothing to rewrite.
  }
  return new Response(text, init);
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
