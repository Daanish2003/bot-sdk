import { storedParts } from "../../../../core/shared/message-parts";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import {
  createPartsBuilder,
  parseStoredParts,
  searchTextOf,
  toModelMessages,
  toUIParts,
} from "../../../../core/shared/chat/parts";

const at = Date.now();
const textStart = (messageId: string): StreamChunk => ({
  type: EventType.TEXT_MESSAGE_START,
  messageId,
  role: "assistant",
  timestamp: at,
});
const textDelta = (messageId: string, delta: string): StreamChunk => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId,
  delta,
  timestamp: at,
});
const reasoningDelta = (messageId: string, delta: string): StreamChunk => ({
  type: EventType.REASONING_MESSAGE_CONTENT,
  messageId,
  delta,
  timestamp: at,
});
const reasoningSignature = (entityId: string, encryptedValue: string): StreamChunk => ({
  type: EventType.REASONING_ENCRYPTED_VALUE,
  subtype: "message",
  entityId,
  encryptedValue,
  timestamp: at,
});
const runStarted: StreamChunk = {
  type: EventType.RUN_STARTED,
  runId: "run",
  threadId: "thread",
  timestamp: at,
};

function build(chunks: StreamChunk[]) {
  const builder = createPartsBuilder();
  for (const chunk of chunks) builder.add(chunk);
  return builder.parts();
}

describe("stored parts from a stream", () => {
  it("collects text deltas into one text part", () => {
    const chunks = [runStarted, textStart("a"), textDelta("a", "Hel"), textDelta("a", "lo!")];

    expect(build(chunks)).toEqual({ schemaVersion: 2, parts: [{ type: "text", text: "Hello!" }] });
  });

  it("starts a new text part for each text message", () => {
    const chunks = [textStart("a"), textDelta("a", "One."), textStart("b"), textDelta("b", "Two.")];

    expect(build(chunks).parts).toEqual([
      { type: "text", text: "One." },
      { type: "text", text: "Two." },
    ]);
  });

  it("leaves out a text message that never got any text", () => {
    expect(build([textStart("a"), textStart("b"), textDelta("b", "Hi")]).parts).toEqual([
      { type: "text", text: "Hi" },
    ]);
  });

  it("collects thinking into a thinking part before the text", () => {
    const chunks = [
      reasoningDelta("r", "Let me "),
      reasoningDelta("r", "think."),
      reasoningSignature("r", "sig-1"),
      textStart("a"),
      textDelta("a", "Answer"),
    ];

    expect(build(chunks).parts).toEqual([
      { type: "thinking", text: "Let me think.", signature: "sig-1" },
      { type: "text", text: "Answer" },
    ]);
  });

  it("keeps a redacted thinking block as its opaque data", () => {
    const id = "redacted_thinking-1";

    expect(build([reasoningSignature(id, "opaque")]).parts).toEqual([
      { type: "thinking", text: "", signature: "opaque", redacted: true },
    ]);
  });

  it("hands out snapshots that later chunks don't change", () => {
    const builder = createPartsBuilder();
    builder.add(textDelta("a", "Hi"));
    const snapshot = builder.parts();

    builder.add(textDelta("a", " there"));

    expect(snapshot.parts).toEqual([{ type: "text", text: "Hi" }]);
    expect(builder.parts().parts).toEqual([{ type: "text", text: "Hi there" }]);
  });
});
describe("stored parts to TanStack AI", () => {
  it("rebuilds provider history as text messages, oldest first", () => {
    const history = [
      {
        role: "user" as const,
        parts: { schemaVersion: 1 as const, parts: [{ type: "text" as const, text: "Hi" }] },
      },
      {
        role: "assistant" as const,
        parts: {
          schemaVersion: 1 as const,
          parts: [
            { type: "text" as const, text: "Hello. " },
            { type: "text" as const, text: "How can I help?" },
          ],
        },
      },
    ];

    expect(toModelMessages(history)).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello. How can I help?" },
    ]);
  });

  it("leaves out a Message with no text, such as a reply that failed before its first token", () => {
    const history = [
      {
        role: "user" as const,
        parts: { schemaVersion: 1 as const, parts: [{ type: "text" as const, text: "Hi" }] },
      },
      { role: "assistant" as const, parts: { schemaVersion: 1 as const, parts: [] } },
      {
        role: "user" as const,
        parts: { schemaVersion: 1 as const, parts: [{ type: "text" as const, text: "Hello?" }] },
      },
    ];

    expect(toModelMessages(history)).toEqual([
      { role: "user", content: "Hi" },
      { role: "user", content: "Hello?" },
    ]);
  });

  describe("thinking", () => {
    const history = [
      { role: "user" as const, parts: storedParts([{ type: "text", text: "Hi" }]) },
      {
        role: "assistant" as const,
        model: "anthropic:claude-sonnet-5-5",
        parts: storedParts([
          { type: "thinking", text: "They said hi.", signature: "sig-1" },
          { type: "thinking", text: "", signature: "opaque", redacted: true },
          { type: "text", text: "Hello!" },
        ]),
      },
      {
        role: "assistant" as const,
        model: "anthropic:claude-sonnet-5-5",
        parts: storedParts([{ type: "thinking", text: "Cut off before any text." }]),
      },
    ];

    it("goes back to the Provider that wrote it, with its signature", () => {
      expect(toModelMessages(history, { provider: "anthropic" })).toEqual([
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: "Hello!",
          thinking: [
            { content: "They said hi.", signature: "sig-1" },
            { content: "", signature: "opaque", redacted: true },
          ],
        },
      ]);
    });

    it("is stripped when the Provider changed, leaving stored history as it was", () => {
      const stored = structuredClone(history);

      expect(toModelMessages(history, { provider: "openai" })).toEqual([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
      ]);
      expect(history).toEqual(stored);
    });
  });

  it("gives useChat text parts", () => {
    const parts = { schemaVersion: 1 as const, parts: [{ type: "text" as const, text: "Hi" }] };

    expect(toUIParts(parts)).toEqual([{ type: "text", content: "Hi" }]);
  });

  it("gives useChat thinking parts, without the Provider's signature", () => {
    const parts = storedParts([
      { type: "thinking", text: "Hmm.", signature: "sig-1" },
      { type: "text", text: "Hi" },
    ]);

    expect(toUIParts(parts)).toEqual([
      { type: "thinking", content: "Hmm." },
      { type: "text", content: "Hi" },
    ]);
  });
});

describe("searchText", () => {
  it("is the plain text of the text parts", () => {
    const parts = {
      schemaVersion: 1 as const,
      parts: [
        { type: "text" as const, text: "First." },
        { type: "text" as const, text: "Second." },
      ],
    };

    expect(searchTextOf(parts)).toBe("First.\nSecond.");
  });
});

describe("reading stored parts", () => {
  it("accepts the current schema version", () => {
    const json = { schemaVersion: 1, parts: [{ type: "text", text: "Hi" }] };

    expect(parseStoredParts(json)).toEqual(json);
  });

  it("refuses an unknown schema version or part", () => {
    expect(() => parseStoredParts({ schemaVersion: 3, parts: [] })).toThrow();
    expect(() =>
      parseStoredParts({ schemaVersion: 1, parts: [{ type: "image", url: "x" }] }),
    ).toThrow();
  });
});

describe("attachments in provider history", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const png = { filename: "cat.png", mediaType: "image/png", bytes: bytes("png-bytes") };
  const pdf = { filename: "spec.pdf", mediaType: "application/pdf", bytes: bytes("%PDF-1.7") };
  const notes = { filename: "notes.md", mediaType: "text/markdown", bytes: bytes("# Notes\nhi") };
  const question = (attachments: (typeof png)[]) => ({
    role: "user" as const,
    parts: storedParts([{ type: "text", text: "What is this?" }]),
    attachments,
  });

  it("sends images and PDFs as inline base64 parts before the text", () => {
    expect(
      toModelMessages([question([png, pdf])], { reads: { images: true, pdfs: true } }),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "data", value: btoa("png-bytes"), mimeType: "image/png" },
          },
          {
            type: "document",
            source: { type: "data", value: btoa("%PDF-1.7"), mimeType: "application/pdf" },
            metadata: { filename: "spec.pdf" },
          },
          { type: "text", content: "What is this?" },
        ],
      },
    ]);
  });

  it("sends text files as text parts, to any Model", () => {
    expect(toModelMessages([question([notes])])).toEqual([
      {
        role: "user",
        content: [
          { type: "text", content: "notes.md\n```\n# Notes\nhi\n```" },
          { type: "text", content: "What is this?" },
        ],
      },
    ]);
  });

  it("fences a text file that contains a fence with a longer one", () => {
    const code = { ...notes, bytes: bytes("```js\nx\n```") };

    const [message] = toModelMessages([question([code])]);

    expect(message?.content).toContainEqual({
      type: "text",
      content: "notes.md\n````\n```js\nx\n```\n````",
    });
  });

  it("replaces images and PDFs the Model can't read with text placeholders", () => {
    expect(
      toModelMessages([question([png, pdf])], { reads: { images: false, pdfs: false } }),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            content: '[Attached image "cat.png" left out: this Model can\'t read images]',
          },
          {
            type: "text",
            content: '[Attached PDF "spec.pdf" left out: this Model can\'t read PDFs]',
          },
          { type: "text", content: "What is this?" },
        ],
      },
    ]);
  });

  it("sends attachments the same way when web search is on", () => {
    expect(toModelMessages([question([notes])], { webSearch: true })).toEqual([
      {
        role: "user",
        content: [
          { type: "text", content: "notes.md\n```\n# Notes\nhi\n```" },
          { type: "text", content: "What is this?" },
        ],
      },
    ]);
  });

  it("keeps plain text content for a Message without attachments", () => {
    expect(toModelMessages([question([])], { reads: { images: true, pdfs: true } })).toEqual([
      { role: "user", content: "What is this?" },
    ]);
  });
});
