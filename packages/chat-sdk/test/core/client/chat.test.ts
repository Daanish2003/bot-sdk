import { describe, expect, it } from "vitest";

import {
  branchFrom,
  describeError,
  messageAttachments,
  messageInfo,
  messageSiblings,
  takePendingFirstMessage,
  toUIMessages,
  setPendingFirstMessage,
  type MessageInfo,
} from "../../../core/client/chat";

const createdAt = new Date("2026-10-06T12:00:00Z");

describe("toUIMessages", () => {
  it("hydrates useChat from the Active Branch, keeping each Message's status and Model", () => {
    const messages = toUIMessages([
      {
        id: "q",
        parentId: null,
        role: "user",
        parts: [{ type: "text", content: "Hi" }],
        attachments: [{ id: "f1", filename: "cat.png", mediaType: "image/png", size: 10 }],
        model: null,
        reasoningEffort: null,
        status: "complete",
        error: null,
        errorReason: null,
        usage: null,
        contextStartId: null,
        createdAt,
        siblings: { index: 0, count: 1, previousId: null, nextId: null },
      },
      {
        id: "a",
        parentId: "q",
        role: "assistant",
        parts: [{ type: "text", content: "Hello" }],
        attachments: [],
        model: "openai:gpt-5.6",
        reasoningEffort: null,
        status: "streaming",
        error: null,
        errorReason: null,
        usage: null,
        contextStartId: null,
        createdAt,
        siblings: { index: 1, count: 2, previousId: "a0", nextId: null },
      },
    ]);

    expect(messages).toEqual([
      {
        id: "q",
        role: "user",
        parts: [{ type: "text", content: "Hi" }],
        createdAt,
        metadata: {
          model: null,
          reasoningEffort: null,
          status: "complete",
          error: null,
          errorReason: null,
          usage: null,
          contextStartId: null,
          siblings: { index: 0, count: 1, previousId: null, nextId: null },
          attachments: [{ id: "f1", filename: "cat.png", mediaType: "image/png", size: 10 }],
        },
      },
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "text", content: "Hello" }],
        createdAt,
        metadata: {
          model: "openai:gpt-5.6",
          reasoningEffort: null,
          status: "streaming",
          error: null,
          errorReason: null,
          usage: null,
          contextStartId: null,
          siblings: { index: 1, count: 2, previousId: "a0", nextId: null },
          attachments: [],
        },
      },
    ]);
    expect(messageInfo(messages[1]!)).toEqual({
      model: "openai:gpt-5.6",
      reasoningEffort: null,
      status: "streaming",
      error: null,
      errorReason: null,
      usage: null,
    });
  });

  it("treats a message useChat is streaming, which has no server metadata, as streaming", () => {
    expect(messageInfo({ id: "x", role: "assistant", parts: [] })).toEqual({
      model: null,
      reasoningEffort: null,
      status: "streaming",
      error: null,
      errorReason: null,
      usage: null,
    });
  });
});

describe("messageAttachments", () => {
  it("reads the attachments the Active Branch gave a Message", () => {
    const [question] = toUIMessages([
      {
        id: "q",
        parentId: null,
        role: "user",
        parts: [],
        attachments: [{ id: "f1", filename: "cat.png", mediaType: "image/png", size: 10 }],
        model: null,
        reasoningEffort: null,
        status: "complete",
        error: null,
        errorReason: null,
        usage: null,
        contextStartId: null,
        createdAt,
        siblings: { index: 0, count: 1, previousId: null, nextId: null },
      },
    ]);
    expect(messageAttachments(question!)).toEqual([
      { id: "f1", filename: "cat.png", mediaType: "image/png", size: 10 },
    ]);
  });

  it("is empty for a message without any", () => {
    expect(messageAttachments({ id: "x", role: "assistant", parts: [] })).toEqual([]);
  });
});

describe("messageSiblings", () => {
  it("reads where the Message sits among its siblings", () => {
    const [, reply] = toUIMessages([
      {
        id: "q",
        parentId: null,
        role: "user",
        parts: [],
        attachments: [],
        model: null,
        reasoningEffort: null,
        status: "complete",
        error: null,
        errorReason: null,
        usage: null,
        contextStartId: null,
        createdAt,
        siblings: { index: 0, count: 1, previousId: null, nextId: null },
      },
      {
        id: "a",
        parentId: "q",
        role: "assistant",
        parts: [],
        attachments: [],
        model: null,
        reasoningEffort: null,
        status: "complete",
        error: null,
        errorReason: null,
        usage: null,
        contextStartId: null,
        createdAt,
        siblings: { index: 0, count: 3, previousId: null, nextId: "a2" },
      },
    ]);
    expect(messageSiblings(reply!)).toEqual({ index: 0, count: 3, previousId: null, nextId: "a2" });
  });

  it("is 1 of 1 for a message useChat is streaming", () => {
    expect(messageSiblings({ id: "x", role: "assistant", parts: [] })).toEqual({
      index: 0,
      count: 1,
      previousId: null,
      nextId: null,
    });
  });
});

describe("branchFrom", () => {
  const shown = [
    { id: "q1", role: "user" as const, parts: [] },
    { id: "a1", role: "assistant" as const, parts: [] },
    { id: "q2", role: "user" as const, parts: [] },
    { id: "a2", role: "assistant" as const, parts: [] },
  ];

  it("edits a Message under the same parent as the original, keeping what came before", () => {
    expect(branchFrom(shown, "q2")).toEqual({ parentId: "a1", history: shown.slice(0, 2) });
  });

  it("edits the first Message into a new root", () => {
    expect(branchFrom(shown, "q1")).toEqual({ parentId: null, history: [] });
  });

  it("regenerates a reply under the Message it answered", () => {
    expect(branchFrom(shown, "a2")).toEqual({ parentId: "q2", history: shown.slice(0, 3) });
  });
});

describe("describeError", () => {
  const info = (fields: Partial<MessageInfo>): MessageInfo => ({
    model: null,
    reasoningEffort: null,
    status: "error",
    error: null,
    errorReason: null,
    usage: null,
    ...fields,
  });

  it("points a rejected key at Key settings", () => {
    expect(describeError(info({ error: "invalid x-api-key", errorReason: "invalid_key" }))).toEqual(
      {
        text: "The Provider rejected your API key.",
        keySettings: true,
      },
    );
  });

  it("explains a rate limit", () => {
    expect(
      describeError(info({ error: "Too many requests", errorReason: "rate_limited" })),
    ).toEqual({
      text: "The Provider rate limited this request. Try again in a moment.",
      keySettings: false,
    });
  });

  it("quotes the Provider for any other Provider error", () => {
    expect(describeError(info({ error: "Overloaded", errorReason: "provider_error" }))).toEqual({
      text: "The Provider returned an error: Overloaded",
      keySettings: false,
    });
  });

  it("still reads well when the Provider gave no message", () => {
    expect(describeError(info({ errorReason: "provider_error" })).text).toBe(
      "The Provider returned an error.",
    );
  });

  it("explains a run that timed out or was interrupted", () => {
    expect(describeError(info({ error: "timed out" })).text).toBe(
      "The reply took too long and timed out.",
    );
    expect(describeError(info({ error: "interrupted" })).text).toBe(
      "The reply was interrupted by a server restart.",
    );
  });
});

describe("pending first message", () => {
  it("is handed out once", () => {
    const pending = {
      text: "Hello",
      attachments: [{ id: "f1", filename: "cat.png", mediaType: "image/png", size: 10 }],
    };
    setPendingFirstMessage("c1", pending);

    expect(takePendingFirstMessage("c1")).toEqual(pending);
    expect(takePendingFirstMessage("c1")).toBeUndefined();
  });
});
