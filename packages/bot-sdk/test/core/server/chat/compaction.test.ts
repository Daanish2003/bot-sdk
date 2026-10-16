import { chat, type ModelMessage, toolDefinition } from "@tanstack/ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  attachmentTokens,
  compactionFor,
  contextBudgetOf,
  contextMarginTokens,
  estimateModelMessageTokens,
} from "../../../../core/server/chat/compaction";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";

/** One ModelMessage per stored Message, each 40 characters, so the budget below cuts a few. */
const ids = ["m0", "m1", "m2", "m3", "m4", "m5"];
const pad = (id: string) => `${id}: ${"x".repeat(60 - id.length - 2)}`;
const history = (): ModelMessage[] =>
  ids.map((id, index) =>
    index % 2 === 0 ? { role: "user", content: pad(id) } : { role: "assistant", content: pad(id) },
  );

const textOf = (message: ModelMessage) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

describe("contextBudgetOf", () => {
  it("is the window less the max output and the margin", () => {
    expect(contextBudgetOf({ contextWindow: 200_000, maxOutputTokens: 8_000 })).toBe(
      200_000 - 8_000 - contextMarginTokens,
    );
  });

  it("reserves nothing for an unknown max output", () => {
    expect(contextBudgetOf({ contextWindow: 200_000, maxOutputTokens: null })).toBe(
      200_000 - contextMarginTokens,
    );
  });

  it("leaves the spec's formula alone when the max output leaves room for input", () => {
    // 128k window and 64k output: the input keeps the rest, margin included.
    expect(contextBudgetOf({ contextWindow: 128_000, maxOutputTokens: 64_000 })).toBe(62_000);
  });

  it("keeps at least half the window when the max output would take all of it", () => {
    // Mistral Medium's max output equals its window: the input still gets half, so "hi" is not refused.
    expect(contextBudgetOf({ contextWindow: 262_144, maxOutputTokens: 262_144 })).toBe(131_072);
  });

  it("is null for an unknown window, so nothing is compacted", () => {
    expect(contextBudgetOf({ contextWindow: null, maxOutputTokens: 8_000 })).toBeNull();
  });
});

describe("estimateModelMessageTokens", () => {
  it("counts text by its length, about a quarter of a token a character", () => {
    const message: ModelMessage = { role: "user", content: "x".repeat(4_000) };
    const tokens = estimateModelMessageTokens(message);
    expect(tokens).toBeGreaterThanOrEqual(1_000);
    expect(tokens).toBeLessThan(1_100);
  });

  it("counts an image as the fixed amount, not its encoded size", () => {
    const image = {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "data", value: "A".repeat(2_000_000), mimeType: "image/png" },
        },
        { type: "text", content: "look" },
      ],
    } as unknown as ModelMessage;

    const tokens = estimateModelMessageTokens(image);
    expect(tokens).toBeGreaterThanOrEqual(attachmentTokens);
    expect(tokens).toBeLessThan(attachmentTokens + 200);
  });

  it("counts a PDF as the fixed amount too", () => {
    const pdf = {
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "data", value: "A".repeat(2_000_000), mimeType: "application/pdf" },
        },
      ],
    } as unknown as ModelMessage;

    const tokens = estimateModelMessageTokens(pdf);
    expect(tokens).toBeGreaterThanOrEqual(attachmentTokens);
    expect(tokens).toBeLessThan(attachmentTokens + 200);
  });
});

describe("compactionFor", () => {
  it("sends the newest Messages, and records the first one kept as the context start", async () => {
    const fake = createFakeAdapter({ rounds: [round(text("ok"))] });
    const compaction = compactionFor({ budget: 80, owners: ids, reply: "reply" });

    await drain(
      chat({ adapter: fake.adapter, messages: history(), middleware: [compaction.middleware] }),
    );

    const sent = fake.calls[0]!.messages.map(textOf);
    expect(sent.some((content) => content.includes("m0:"))).toBe(false);
    expect(sent.some((content) => content.includes("m5:"))).toBe(true);
    const start = compaction.contextStartId();
    expect(start).not.toBeNull();
    expect(sent.some((content) => content.includes(`${start}:`))).toBe(true);
    expect(start).not.toBe("m0");
  });

  it("records no context start when everything fits", async () => {
    const fake = createFakeAdapter({ rounds: [round(text("ok"))] });
    const compaction = compactionFor({ budget: 10_000, owners: ids, reply: "reply" });

    await drain(
      chat({ adapter: fake.adapter, messages: history(), middleware: [compaction.middleware] }),
    );

    expect(fake.calls[0]!.messages).toHaveLength(ids.length);
    expect(compaction.contextStartId()).toBeNull();
  });

  it("records the reply itself when a tool iteration's cut lands on the Run's own Message", async () => {
    const lookup = toolDefinition({
      name: "lookup",
      description: "Looks a thing up",
      inputSchema: z.object({ q: z.string() }),
    }).server(async () => "found");
    const fake = createFakeAdapter({
      rounds: [round(toolCall({ name: "lookup", input: { q: "a" } })), round(text("done"))],
    });
    const compaction = compactionFor({ budget: 80, owners: ids, reply: "reply" });

    await drain(
      chat({
        adapter: fake.adapter,
        messages: history(),
        tools: [lookup],
        middleware: [compaction.middleware],
      }),
    );

    expect(fake.calls).toHaveLength(2);
    // The second call is cut past the stored history, so the first Message it saw is this Run's own.
    expect(compaction.contextStartId()).toBe("reply");
  });
});

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _chunk of stream) {
    // Drained so the Run completes.
  }
}
