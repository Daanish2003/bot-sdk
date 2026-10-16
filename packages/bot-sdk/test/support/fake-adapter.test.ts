import { chat, EventType, type StreamChunk, toolDefinition } from "@tanstack/ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createFakeAdapter,
  round,
  runError,
  text,
  thinking,
  toolCall,
  withUsage,
} from "./fake-adapter";

const hello = [{ role: "user" as const, content: "Hello" }];

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function deltas(chunks: StreamChunk[], type: EventType) {
  return chunks.flatMap((chunk) =>
    chunk.type === type && "delta" in chunk && typeof chunk.delta === "string" ? [chunk.delta] : [],
  );
}

describe("createFakeAdapter", () => {
  it("streams a scripted text reply through chat()", async () => {
    const fake = createFakeAdapter({ rounds: [round(text("Hi ", "there"))] });

    const reply = await chat({ adapter: fake.adapter, messages: hello, stream: false });

    expect(reply.text).toBe("Hi there");
    expect(fake.calls).toHaveLength(1);
  });

  it("streams thinking as REASONING_* events", async () => {
    const fake = createFakeAdapter({ rounds: [round(thinking("Let me think"), text("Done"))] });

    const chunks = await collect(chat({ adapter: fake.adapter, messages: hello }));

    expect(deltas(chunks, EventType.REASONING_MESSAGE_CONTENT)).toEqual(["Let me think"]);
    expect(deltas(chunks, EventType.TEXT_MESSAGE_CONTENT)).toEqual(["Done"]);
  });

  it("plays one round per tool-loop iteration", async () => {
    const inputs: unknown[] = [];
    const lookup = toolDefinition({
      name: "lookup",
      description: "Looks something up",
      inputSchema: z.object({ query: z.string() }),
    }).server(async (input) => {
      inputs.push(input);
      return { answer: 42 };
    });
    const fake = createFakeAdapter({
      rounds: [
        round(toolCall({ id: "call-1", name: "lookup", input: { query: "meaning" } })),
        round(text("It is 42")),
      ],
    });

    const reply = await chat({
      adapter: fake.adapter,
      messages: hello,
      tools: [lookup],
      stream: false,
    });

    expect(inputs).toEqual([{ query: "meaning" }]);
    expect(reply.text).toBe("It is 42");
    expect(fake.calls).toHaveLength(2);
    expect(JSON.stringify(fake.calls[1]?.messages)).toContain("42");
  });

  it("ends a round with a run error", async () => {
    const fake = createFakeAdapter({
      rounds: [round(text("Partial"), runError("Rate limited", "rate_limited"))],
    });

    const chunks = await collect(chat({ adapter: fake.adapter, messages: hello }));

    expect(chunks.at(-1)).toMatchObject({ type: "RUN_ERROR", message: "Rate limited" });
    expect(chunks.some((chunk) => chunk.type === "RUN_FINISHED")).toBe(false);
  });

  it("holds every chunk until the test releases it", async () => {
    const fake = createFakeAdapter({ rounds: [round(text("a", "b"))], manual: true });
    const received: string[] = [];
    const done = (async () => {
      for await (const chunk of chat({ adapter: fake.adapter, messages: hello })) {
        if (chunk.type === "TEXT_MESSAGE_CONTENT") received.push(chunk.delta);
      }
    })();

    await fake.release(2); // RUN_STARTED, TEXT_MESSAGE_START
    expect(received).toEqual([]);
    await fake.release(); // "a"
    expect(received).toEqual(["a"]);
    await fake.release(); // "b"
    expect(received).toEqual(["a", "b"]);
    await fake.releaseAll();
    await done;
  });

  it("settles releaseAll when a run error ends the run before the last round", async () => {
    const fake = createFakeAdapter({
      rounds: [round(text("a"), runError("Boom")), round(text("unused"))],
      manual: true,
    });
    const done = collect(chat({ adapter: fake.adapter, messages: hello }));

    await fake.releaseAll();
    const chunks = await done;

    expect(chunks.at(-1)).toMatchObject({ type: "RUN_ERROR", message: "Boom" });
  });

  it("stops streaming when the run is aborted while a chunk is held", async () => {
    const fake = createFakeAdapter({ rounds: [round(text("never"))], manual: true });
    const abortController = new AbortController();
    const done = collect(chat({ adapter: fake.adapter, messages: hello, abortController }));

    await fake.release(); // RUN_STARTED
    abortController.abort();
    const chunks = await done;

    expect(deltas(chunks, EventType.TEXT_MESSAGE_CONTENT)).toEqual([]);
  });

  it("emits the usage a round is scripted with on its RUN_FINISHED", async () => {
    const usage = { promptTokens: 12, completionTokens: 5, totalTokens: 17 };
    const fake = createFakeAdapter({ rounds: [withUsage(round(text("Hi")), usage)] });

    const chunks = await collect(chat({ adapter: fake.adapter, messages: hello }));

    expect(chunks.find((chunk) => chunk.type === "RUN_FINISHED")).toMatchObject({ usage });
  });

  it("emits no usage on RUN_FINISHED for a round scripted without it", async () => {
    const lookup = toolDefinition({
      name: "lookup",
      description: "Looks something up",
      inputSchema: z.object({ query: z.string() }),
    }).server(async () => ({ answer: 42 }));
    const fake = createFakeAdapter({
      rounds: [
        withUsage(round(toolCall({ id: "call-1", name: "lookup", input: { query: "x" } })), {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        }),
        round(text("No usage here")),
      ],
    });

    const chunks = await collect(chat({ adapter: fake.adapter, messages: hello, tools: [lookup] }));
    const finishes = chunks.filter((chunk) => chunk.type === "RUN_FINISHED");

    expect(finishes).toHaveLength(2);
    expect(finishes[0]).toHaveProperty("usage");
    expect(finishes[1]?.usage).toBeUndefined();
  });
});
