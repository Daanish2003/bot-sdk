import { chat, EventType, toolDefinition, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import {
  COMPACTION_STATE_EVENT,
  type CompactionInfo,
  type CompactionStateEventValue,
  evictOldest,
  withCompaction,
} from "@tanstack/ai-compaction";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";

/**
 * Tracer for #115: can `withCompaction` (evictOldest) tell us which stored Messages it dropped?
 *
 * The Run sends one ModelMessage per stored Message here (no tools, no attachments), so
 * `storedIds[i]` is the Message behind the i-th history ModelMessage. Each text is 40 characters,
 * which the default estimator (chars / 4) counts as 10 tokens.
 */

const storedIds = ["m0", "m1", "m2", "m3", "m4", "m5"];
const pad = (id: string) => `${id}: ${"x".repeat(40 - id.length - 2)}`;

function history(): ModelMessage[] {
  return storedIds.map((id, index) =>
    index % 2 === 0 ? { role: "user", content: pad(id) } : { role: "assistant", content: pad(id) },
  );
}

/** Drains a chat() stream, keeping every chunk so custom events can be read back. */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** The text of a provider message, for assertions. */
const textOf = (message: ModelMessage) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

/**
 * Index in the sent list of the first Message the Model saw. evictOldest puts one marker first,
 * so the cut is `messagesBefore - (messagesAfter - 1)`.
 */
const firstKeptOf = (info: CompactionInfo) => info.messagesBefore - (info.messagesAfter - 1);

describe("compaction tracer (#115): evictOldest with a small budget", () => {
  it("sends the model the newest Messages, with a marker in place of the oldest", async () => {
    const fake = createFakeAdapter({ rounds: [round(text("ok"))] });
    const infos: CompactionInfo[] = [];

    await drain(
      chat({
        adapter: fake.adapter,
        messages: history(),
        middleware: [withCompaction({ maxTokens: 40, onCompact: (info) => infos.push(info) })],
      }),
    );

    const sent = fake.calls[0]!.messages.map(textOf);
    expect(sent.some((content) => content.includes("m0:"))).toBe(false);
    expect(sent.some((content) => content.includes("m1:"))).toBe(false);
    expect(sent.some((content) => content.includes("m4:"))).toBe(true);
    expect(sent.some((content) => content.includes("m5:"))).toBe(true);
    expect(fake.calls[0]!.messages[0]).toMatchObject({ role: "user" });
    expect(sent[0]).toContain("earlier message(s) omitted");
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ before: 60, messagesBefore: 6, messagesAfter: 3 });
  });

  it("maps the first kept Message back to its stored id from the onCompact counts alone", async () => {
    const fake = createFakeAdapter({ rounds: [round(text("ok"))] });
    const infos: CompactionInfo[] = [];

    await drain(
      chat({
        adapter: fake.adapter,
        messages: history(),
        middleware: [withCompaction({ maxTokens: 40, onCompact: (info) => infos.push(info) })],
      }),
    );

    expect(storedIds[firstKeptOf(infos[0]!)]).toBe("m4");
  });

  it("reports the dropped Messages in compaction:state only as previews, without ids", async () => {
    const fake = createFakeAdapter({ rounds: [round(text("ok"))] });
    // "ok" at index 0 is dropped and an identical "ok" at the end is kept: a JSON-equality diff
    // cannot tell them apart, so the dropped list leaves the first one out.
    const messages: ModelMessage[] = [
      { role: "user", content: "ok" },
      ...history().slice(1, 5),
      { role: "user", content: "ok" },
    ];

    const chunks = await drain(
      chat({ adapter: fake.adapter, messages, middleware: [withCompaction({ maxTokens: 40 })] }),
    );

    const state = chunks.find(
      (chunk): chunk is Extract<StreamChunk, { type: "CUSTOM" }> =>
        chunk.type === EventType.CUSTOM && chunk.name === COMPACTION_STATE_EVENT,
    );
    const value = state?.value as CompactionStateEventValue;
    expect(value.dropped?.length).toBeGreaterThan(0);
    expect(value.dropped?.map((preview) => preview.text)).not.toContain("ok");
    expect(value.dropped?.every((preview) => !("id" in preview))).toBe(true);
    expect(value.result?.every((preview) => !("id" in preview))).toBe(true);
  });

  it("evicts again in a tool iteration of the same Run, and the cut can land on the Run's own Message", async () => {
    const lookup = toolDefinition({
      name: "lookup",
      description: "Looks a thing up",
      inputSchema: z.object({ q: z.string() }),
    }).server(async () => "found");
    const fake = createFakeAdapter({
      rounds: [round(toolCall({ name: "lookup", input: { q: "a" } })), round(text("done"))],
    });
    const infos: CompactionInfo[] = [];

    await drain(
      chat({
        adapter: fake.adapter,
        messages: history(),
        tools: [lookup],
        middleware: [withCompaction({ maxTokens: 40, onCompact: (info) => infos.push(info) })],
      }),
    );

    expect(fake.calls).toHaveLength(2);
    // The second model call is compacted from the canonical list, which now holds the tool round.
    expect(infos.map((info) => info.messagesBefore)).toEqual([6, 8]);
    expect(firstKeptOf(infos[0]!)).toBe(4);
    expect(firstKeptOf(infos[1]!)).toBe(6);
    // Index 6 is past the six stored Messages: the first Message the Model saw is this Run's own tool call.
    expect(storedIds[firstKeptOf(infos[1]!)]).toBeUndefined();
    const secondSent = fake.calls[1]!.messages;
    expect(secondSent.map(textOf).some((content) => content.includes("m5:"))).toBe(false);
    expect(secondSent.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("accepts a custom estimator that counts an attachment as a fixed amount, and evicts differently", async () => {
    const image = {
      role: "user",
      content: [
        { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
        { type: "text", content: "look" },
      ],
    } as unknown as ModelMessage;
    // The attachment is the newest Message, so it is always kept; what changes is how much older history fits beside it.
    const messages = [...history().slice(0, 5), image];
    const countAttachmentAsFixed = (message: ModelMessage) =>
      Array.isArray(message.content)
        ? message.content.reduce(
            (total, part) =>
              total + (part.type === "image" ? 1_000 : Math.ceil(JSON.stringify(part).length / 4)),
            0,
          )
        : Math.ceil(textOf(message).length / 4);
    // A budget of 40 with room to keep 60 tokens of recent history.
    const strategy = evictOldest({ keepRecentTokens: 60 });

    const defaultRun = createFakeAdapter({ rounds: [round(text("ok"))] });
    const defaultInfos: CompactionInfo[] = [];
    await drain(
      chat({
        adapter: defaultRun.adapter,
        messages,
        middleware: [
          withCompaction({ maxTokens: 40, strategy, onCompact: (info) => defaultInfos.push(info) }),
        ],
      }),
    );

    const customRun = createFakeAdapter({ rounds: [round(text("ok"))] });
    const customInfos: CompactionInfo[] = [];
    await drain(
      chat({
        adapter: customRun.adapter,
        messages,
        middleware: [
          withCompaction({
            maxTokens: 40,
            strategy,
            estimateTokens: countAttachmentAsFixed,
            onCompact: (info) => customInfos.push(info),
          }),
        ],
      }),
    );

    expect(defaultInfos).toHaveLength(1);
    expect(customInfos).toHaveLength(1);
    expect(defaultInfos[0]!.messagesAfter).toBe(5);
    expect(customInfos[0]!.messagesAfter).toBe(2);
    const customSent = customRun.calls[0]!.messages;
    expect(customSent.map(textOf).some((content) => content.includes("m3:"))).toBe(false);
    expect(customSent.at(-1)).toMatchObject({ role: "user" });
  });
});
