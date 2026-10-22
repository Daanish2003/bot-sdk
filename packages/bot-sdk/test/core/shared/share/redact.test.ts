import type { MessagePart } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { parseStoredParts, toUIParts } from "../../../../plugins/assistant/shared/chat/parts";
import { storedParts } from "../../../../plugins/assistant/shared/message-parts";
import {
  redactAttachmentsForShare,
  redactForShare,
} from "../../../../plugins/assistant/shared/share/redact";

describe("redactForShare", () => {
  it("keeps a fetch_url call in full: it is a builtin tool, read as a Source", () => {
    const fetchCall = {
      type: "tool-call",
      id: "call-2",
      name: "fetch_url",
      arguments: '{"url":"https://example.com/page"}',
      input: { url: "https://example.com/page" },
      state: "complete",
      output: { url: "https://example.com/page", title: "Page", content: "Hello." },
      metadata: { source: "builtin", status: "done" },
    } as MessagePart;

    expect(redactForShare([fetchCall])).toEqual([fetchCall]);
  });

  it("keeps text and web-search tool calls and results", () => {
    const parts: MessagePart[] = [
      { type: "text", content: "Let me look that up." },
      {
        type: "tool-call",
        id: "call-1",
        name: "web_search",
        arguments: '{"query":"tanstack ai"}',
        state: "input-complete",
      },
      { type: "tool-result", toolCallId: "call-1", content: "[]", state: "complete" },
      { type: "text", content: "Here's what I found." },
    ];

    expect(redactForShare(parts)).toEqual(parts);
  });

  it("keeps the slim artifact part: it names a version, never its content", () => {
    const artifactPart = {
      type: "artifact",
      artifactId: "abc123",
      version: 2,
      title: "Landing page",
      kind: "html",
      state: "done",
    } as unknown as MessagePart;

    expect(redactForShare([artifactPart])).toEqual([artifactPart]);
  });

  it("strips thinking", () => {
    expect(
      redactForShare([
        { type: "thinking", content: "The user probably means…", signature: "sig" },
        { type: "text", content: "Answer" },
      ]),
    ).toEqual([{ type: "text", content: "Answer" }]);
  });

  it("never passes on file contents", () => {
    expect(
      redactForShare([
        { type: "image", source: { type: "data", value: "aGVsbG8=", mimeType: "image/png" } },
        {
          type: "document",
          source: { type: "data", value: "aGVsbG8=", mimeType: "application/pdf" },
        },
        { type: "text", content: "What's in these?" },
      ]),
    ).toEqual([{ type: "text", content: "What's in these?" }]);
  });
});

describe("redactForShare with Generated images", () => {
  it("keeps a stored generated_image part, with its image id, prompt and shape", () => {
    const stored = storedParts([
      { type: "text", text: "Here it is." },
      {
        type: "generated_image",
        toolCallId: "call-1",
        prompt: "a red bicycle",
        aspectRatio: "landscape",
        state: "done",
        imageId: "0199a1b2-0000-7000-8000-0000000000aa",
      },
    ]);

    const parts = redactForShare(toUIParts(parseStoredParts(stored)));

    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({
      type: "tool-call",
      name: "generate_image",
      input: { prompt: "a red bicycle", aspectRatio: "landscape" },
      output: { imageId: "0199a1b2-0000-7000-8000-0000000000aa" },
    });
  });
});

describe("redactAttachmentsForShare", () => {
  it("keeps only each attachment's filename and type, for chips", () => {
    expect(
      redactAttachmentsForShare([
        {
          id: "0199a1b2-0000-7000-8000-000000000001",
          filename: "cat.png",
          mediaType: "image/png",
          size: 1234,
        },
      ]),
    ).toEqual([{ filename: "cat.png", mediaType: "image/png" }]);
  });
});
