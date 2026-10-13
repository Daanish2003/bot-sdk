import type { MessagePart } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { toolCallOf } from "../../../../core/shared/chat/tool-call";

const streaming = (arguments_: string): MessagePart =>
  ({
    type: "tool-call",
    id: "call-1",
    name: "create_artifact",
    arguments: arguments_,
    state: "input-streaming",
  }) as MessagePart;

describe("the arguments of a tool call that is still streaming", () => {
  it("reads the arguments received so far, as a partial parse", () => {
    const call = toolCallOf(streaming('{"kind":"html","content":"<h1>Hel'));

    expect(call?.args).toEqual({ kind: "html", content: "<h1>Hel" });
  });

  it("reads nothing before the first argument byte arrives", () => {
    expect(toolCallOf(streaming(""))?.args).toBeUndefined();
  });
});
