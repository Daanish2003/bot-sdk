import { type StoredPart, storedParts } from "../../../../core/shared/message-parts";
import { EventType } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import {
  cancelRunningCalls,
  createPartsBuilder,
  parseStoredParts,
  toModelMessages,
  toUIParts,
} from "../../../../core/shared/chat/parts";

const hostCall = (
  fields: Partial<Extract<StoredPart, { type: "tool_call" }>> = {},
): StoredPart => ({
  type: "tool_call",
  toolCallId: "call-1",
  name: "server_time",
  source: "host",
  args: { zone: "UTC" },
  result: { now: "noon" },
  state: "done",
  ...fields,
});

const text = (value: string): StoredPart => ({ type: "text", text: value });

describe("tool calls in stored parts from a stream", () => {
  it("adds a running call in stream order and finishes it with its result", () => {
    const builder = createPartsBuilder();
    builder.add({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "a",
      delta: "Let me check.",
      timestamp: 0,
    });

    builder.startToolCall({
      toolCallId: "call-1",
      name: "server_time",
      source: "host",
      args: { zone: "UTC" },
    });
    expect(builder.parts().parts).toEqual([
      text("Let me check."),
      hostCall({ result: undefined, state: "running" }),
    ]);

    builder.finishToolCall("call-1", { state: "done", result: { now: "noon" } });
    expect(builder.parts().parts).toEqual([text("Let me check."), hostCall()]);
  });

  it("closes running calls as cancelled, and leaves finished ones alone", () => {
    const builder = createPartsBuilder();
    builder.startToolCall({ toolCallId: "call-1", name: "server_time", source: "host", args: {} });
    builder.startToolCall({ toolCallId: "call-2", name: "server_time", source: "host", args: {} });
    builder.finishToolCall("call-2", { state: "error", result: { error: "boom" } });

    builder.cancelRunningCalls();

    expect(builder.parts().parts).toEqual([
      hostCall({ toolCallId: "call-1", args: {}, result: undefined, state: "cancelled" }),
      hostCall({ toolCallId: "call-2", args: {}, result: { error: "boom" }, state: "error" }),
    ]);
  });

  it("cancelRunningCalls closes stored running calls too", () => {
    const parts = storedParts([hostCall({ result: undefined, state: "running" })]);

    expect(cancelRunningCalls(parts).parts).toEqual([
      hostCall({ result: undefined, state: "cancelled" }),
    ]);
  });
});

describe("tool calls as the Model sees them", () => {
  it("replays a finished host call as a tool call with its result", () => {
    const messages = toModelMessages(
      [
        {
          role: "assistant",
          parts: storedParts([text("Let me check."), hostCall(), text("Noon.")]),
        },
      ],
      { hostTools: true },
    );

    expect(messages).toEqual([
      {
        role: "assistant",
        content: "Let me check.",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "server_time", arguments: JSON.stringify({ zone: "UTC" }) },
          },
        ],
      },
      { role: "tool", toolCallId: "call-1", content: JSON.stringify({ now: "noon" }) },
      { role: "assistant", content: "Noon." },
    ]);
  });

  it("leaves a call without a result out when it is replayed as a tool call", () => {
    const messages = toModelMessages(
      [
        {
          role: "assistant",
          parts: storedParts([hostCall({ result: undefined, state: "cancelled" })]),
        },
      ],
      { hostTools: true },
    );

    expect(messages).toEqual([]);
  });

  it("replays a host call as a text placeholder when no tools are offered", () => {
    const messages = toModelMessages(
      [{ role: "assistant", parts: storedParts([text("Let me check."), hostCall()]) }],
      { hostTools: false },
    );

    expect(messages).toEqual([
      {
        role: "assistant",
        content: 'Let me check.\n\n[Called "server_time" with {"zone":"UTC"}: {"now":"noon"}]',
      },
    ]);
  });

  it("keeps a search as a text placeholder when only host tools are offered", () => {
    const messages = toModelMessages(
      [
        {
          role: "assistant",
          parts: storedParts([
            {
              type: "web_search",
              toolCallId: "search-1",
              query: "tanstack",
              state: "done",
              results: [{ title: "TanStack", url: "https://tanstack.com", snippet: "" }],
            },
          ]),
        },
      ],
      { hostTools: true, webSearch: false },
    );

    expect(messages).toEqual([
      {
        role: "assistant",
        content: '[Searched the web for "tanstack": TanStack (https://tanstack.com)]',
      },
    ]);
  });
});

describe("tool calls as useChat parts", () => {
  it("maps a finished host call to a complete tool-call part with its input and output", () => {
    expect(toUIParts(storedParts([hostCall()]))).toEqual([
      {
        type: "tool-call",
        id: "call-1",
        name: "server_time",
        arguments: JSON.stringify({ zone: "UTC" }),
        input: { zone: "UTC" },
        state: "complete",
        output: { now: "noon" },
        metadata: { source: "host", status: "done" },
      },
    ]);
  });

  it("maps a failed call to an error state with its error as output", () => {
    const [part] = toUIParts(
      storedParts([hostCall({ state: "error", result: { error: "boom" } })]),
    );
    expect(part).toMatchObject({ state: "error", output: { error: "boom" } });
  });

  it("maps a running call to input-complete and a cancelled one to error without output", () => {
    const [running, cancelled] = toUIParts(
      storedParts([
        hostCall({ toolCallId: "a", result: undefined, state: "running" }),
        hostCall({ toolCallId: "b", result: undefined, state: "cancelled" }),
      ]),
    );
    expect(running).toMatchObject({ state: "input-complete", metadata: { status: "running" } });
    expect(cancelled).toMatchObject({ state: "error", metadata: { status: "cancelled" } });
    expect(cancelled).not.toHaveProperty("output");
  });
});

describe("stored parts schema versions", () => {
  it("still reads a schemaVersion 1 row", () => {
    const row = {
      schemaVersion: 1,
      parts: [
        text("Hello."),
        {
          type: "web_search",
          toolCallId: "search-1",
          query: "tanstack",
          state: "done",
          results: [],
        },
      ],
    };

    expect(parseStoredParts(row)).toEqual(row);
  });
});
