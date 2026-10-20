import { chat, toolDefinition } from "@tanstack/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { adapterFor } from "../../../../plugins/models/server/adapters";

/** One server-sent event of the Responses stream. */
const event = (data: Record<string, unknown>) =>
  `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

const response = (output: unknown[] = []) => ({
  id: "resp_1",
  object: "response",
  model: "gpt-6.1-sol",
  status: "completed",
  output,
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});

const functionCall = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "get_weather",
  arguments: '{"city":"Pune"}',
  status: "completed",
};

/**
 * The plan route's "lite" stream (#639): the call streams as an output item, but
 * `response.completed` comes with an empty `output`. Like the plan's, it has no content-type.
 */
const liteToolCallStream = () =>
  [
    event({ type: "response.created", response: response() }),
    event({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...functionCall, arguments: "", status: "in_progress" },
    }),
    event({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 0,
      delta: functionCall.arguments,
    }),
    event({
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      output_index: 0,
      arguments: functionCall.arguments,
    }),
    event({ type: "response.output_item.done", output_index: 0, item: functionCall }),
    event({ type: "response.completed", response: response() }),
  ].join("");

const liteTextStream = (text: string) =>
  [
    event({ type: "response.created", response: response() }),
    event({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: text }),
    event({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    }),
    event({ type: "response.completed", response: response() }),
  ].join("");

/** Stubs the global `fetch` with `bodies` played in order, recording each request's JSON body. */
function stubOpenai(bodies: Array<string | Response>) {
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const next = bodies.shift();
      if (next === undefined) throw new Error("No more stubbed responses");
      return typeof next === "string" ? new Response(next, { status: 200 }) : next;
    }),
  );
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const weather = toolDefinition({
  name: "get_weather",
  description: "The weather in a city",
  inputSchema: z.object({ city: z.string() }),
});

describe("a call on a linked ChatGPT plan (ADR 0023, #639)", () => {
  it("runs a tool call from the plan's lite stream, then streams the final text, with store off", async () => {
    const requests = stubOpenai([liteToolCallStream(), liteTextStream("Sunny in Pune.")]);
    const ran: unknown[] = [];
    const adapter = adapterFor(
      "openai:gpt-6.1-sol",
      { apiKey: "chatgpt-access-token" },
      { linked: true },
    );

    const result = await chat({
      adapter,
      messages: [{ role: "user", content: "Weather in Pune?" }],
      tools: [
        weather.server(async (input) => {
          ran.push(input);
          return { forecast: "sunny" };
        }),
      ],
      stream: false,
    });

    expect(ran).toEqual([{ city: "Pune" }]);
    expect(result.text).toBe("Sunny in Pune.");
    expect(requests.map((body) => body.store)).toEqual([false, false]);
    // The tool's result went back to the plan with the call.
    expect(JSON.stringify(requests[1]?.input)).toContain("function_call_output");
  });

  it("runs the tool call when the stream's CRLF event breaks fall across chunks", async () => {
    // Every event ends "\r\n\r\n", and each chunk ends inside that break, after its "\r".
    const crlf = liteToolCallStream().replaceAll("\n", "\r\n");
    const chunks = crlf
      .split("\r\n\r")
      .map((part, index, all) => (index < all.length - 1 ? `${part}\r\n\r` : part));
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    stubOpenai([new Response(body, { status: 200 }), liteTextStream("Sunny.")]);
    const ran: unknown[] = [];
    const adapter = adapterFor("openai:gpt-6.1-sol", { apiKey: "t" }, { linked: true });

    await chat({
      adapter,
      messages: [{ role: "user", content: "Weather in Pune?" }],
      tools: [
        weather.server(async (input) => {
          ran.push(input);
          return { forecast: "sunny" };
        }),
      ],
      stream: false,
    });

    expect(chunks.join("")).toBe(crlf);
    expect(ran).toEqual([{ city: "Pune" }]);
  });

  it("sends reasoning effort none as low, which the plan's Models accept", async () => {
    const requests = stubOpenai([liteTextStream("Hi.")]);
    const adapter = adapterFor("openai:gpt-6.1-sol", { apiKey: "t" }, { linked: true });

    await chat({
      adapter,
      messages: [{ role: "user", content: "Hi" }],
      modelOptions: { reasoning: { effort: "none" } },
      stream: false,
    });

    expect(requests[0]?.reasoning).toEqual({ effort: "low" });
  });

  it("asks the user to reconnect ChatGPT when the plan rejects the token", async () => {
    stubOpenai([
      new Response(JSON.stringify({ error: { message: "Invalid token", code: "token_expired" } }), {
        status: 401,
      }),
    ]);
    const adapter = adapterFor("openai:gpt-6.1-sol", { apiKey: "t" }, { linked: true });

    const chunks = [];
    for await (const chunk of chat({ adapter, messages: [{ role: "user", content: "Hi" }] })) {
      chunks.push(chunk);
    }

    const failed = chunks.find((chunk) => chunk.type === "RUN_ERROR");
    expect(failed).toMatchObject({ message: expect.stringContaining("Reconnect ChatGPT") });
  });

  it("leaves a call on the user's own API key as it was: store is not set", async () => {
    const requests = stubOpenai([liteTextStream("Hi.")]);
    const adapter = adapterFor("openai:gpt-6.1-sol", { apiKey: "sk-own" });

    await chat({
      adapter,
      messages: [{ role: "user", content: "Hi" }],
      modelOptions: { reasoning: { effort: "none" } },
      stream: false,
    });

    expect(requests[0]).not.toHaveProperty("store");
    expect(requests[0]?.reasoning).toEqual({ effort: "none" });
  });
});
