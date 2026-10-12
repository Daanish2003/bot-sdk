import type { MessagePart } from "@tanstack/ai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { toolCallOf } from "../../../core/shared/chat/tool-call";
import { ToolCallDetails, ToolCallRow } from "../../../ui/chat/tool-call-row";

const part = (fields: Partial<Extract<MessagePart, { type: "tool-call" }>>): MessagePart =>
  ({
    type: "tool-call",
    id: "call-1",
    name: "server_time",
    arguments: JSON.stringify({ zone: "UTC" }),
    input: { zone: "UTC" },
    state: "complete",
    output: { now: "noon" },
    metadata: { source: "host", status: "done" },
    ...fields,
  }) as MessagePart;

const render = (value: MessagePart) => {
  const call = toolCallOf(value);
  if (!call) throw new Error("Expected a tool call");
  return renderToStaticMarkup(createElement(ToolCallRow, { call }));
};

describe("a tool call row", () => {
  it.each([
    [
      "running",
      part({
        state: "input-complete",
        output: undefined,
        metadata: { source: "host", status: "running" },
      }),
      "Running",
    ],
    ["done", part({}), "Done"],
    [
      "failed",
      part({
        state: "error",
        output: { error: "boom" },
        metadata: { source: "host", status: "error" },
      }),
      "Failed",
    ],
    [
      "cancelled",
      part({
        state: "error",
        output: undefined,
        metadata: { source: "host", status: "cancelled" },
      }),
      "Cancelled",
    ],
  ])("shows the %s state by name", (_name, value, label) => {
    expect(render(value)).toContain(label);
    expect(render(value)).toContain("server_time");
  });

  it("shows the arguments and result when expanded", () => {
    const call = toolCallOf(part({}));
    if (!call) throw new Error("Expected a tool call");

    const html = renderToStaticMarkup(createElement(ToolCallDetails, { call }));

    expect(html).toContain("{&quot;zone&quot;:&quot;UTC&quot;}");
    expect(html).toContain("{&quot;now&quot;:&quot;noon&quot;}");
  });

  it("shows only that it was used for a redacted call, with no arguments or result", () => {
    const html = render(
      part({
        arguments: "",
        input: undefined,
        output: undefined,
        metadata: { source: "host", status: "done", redacted: true },
      }),
    );

    expect(html).toContain("Used server_time");
    expect(html).not.toContain("zone");
    expect(html).not.toContain("noon");
  });

  const waitingPart = part({
    state: "input-complete",
    output: undefined,
    metadata: { source: "host", status: "awaiting_approval" },
  });

  it("shows a call waiting for Approval with its name, its full arguments and Approve and Deny", () => {
    const call = toolCallOf(waitingPart);
    if (!call) throw new Error("Expected a tool call");

    const html = renderToStaticMarkup(createElement(ToolCallRow, { call, onDecide: () => {} }));

    expect(html).toContain("Waiting for approval");
    expect(html).toContain("server_time");
    expect(html).toContain("{&quot;zone&quot;:&quot;UTC&quot;}");
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Deny<");
  });

  it("offers a third choice on a waiting call: allow this tool for the rest of the Conversation", () => {
    const call = toolCallOf(waitingPart);
    if (!call) throw new Error("Expected a tool call");

    const html = renderToStaticMarkup(createElement(ToolCallRow, { call, onDecide: () => {} }));

    expect(html).toContain(">Allow for this Conversation<");
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Deny<");
  });

  it("shows a waiting call, distinct from a streaming one, with no controls without a decision handler", () => {
    const waiting = render(waitingPart);
    const streaming = render(
      part({
        state: "input-complete",
        output: undefined,
        metadata: { source: "host", status: "running" },
      }),
    );

    expect(waiting).toContain("Waiting for approval");
    expect(waiting).not.toContain("Running");
    expect(streaming).not.toContain("Waiting for approval");
    expect(waiting).not.toContain(">Approve<");
  });

  it("shows a waiting call on a Shared link as waiting, without its arguments or controls", () => {
    const html = render(
      part({
        arguments: "",
        input: undefined,
        output: undefined,
        metadata: { source: "host", status: "awaiting_approval", redacted: true },
      }),
    );

    expect(html).toContain("Waiting for approval to use server_time");
    expect(html).not.toContain("zone");
    expect(html).not.toContain(">Approve<");
  });
});
