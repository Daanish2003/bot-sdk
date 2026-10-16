import type { UIMessage } from "@tanstack/ai-react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { MessageRow } from "../../../plugins/assistant/ui/chat/message-row";
import { renderInChat } from "../../support/chat-provider";

const actions = {
  streaming: false,
  model: "anthropic:claude-sonnet-5-5",
  onEdit: () => {},
  onRegenerate: () => {},
  onSwitchBranch: () => {},
  onRate: () => {},
};

/** A reply as `toUIMessages` builds it from the Active Branch. */
function reply(hidden: boolean): UIMessage {
  return {
    id: "reply-1",
    role: "assistant",
    parts: hidden ? [] : [{ type: "text", content: "Forbidden words" }],
    createdAt: new Date("2026-10-13T10:00:00Z"),
    metadata: {
      model: "anthropic:claude-sonnet-5-5",
      reasoningEffort: null,
      status: "complete",
      error: null,
      errorReason: null,
      usage: null,
      rating: null,
      hidden,
    },
  } as UIMessage;
}

describe("a Hidden reply", () => {
  it("renders the hidden stub in place of the text, with no Copy", () => {
    const html = renderInChat(createElement(MessageRow, { message: reply(true), actions }));

    expect(html).toContain("This reply was hidden");
    expect(html).not.toContain("Forbidden words");
    expect(html).not.toContain('aria-label="Copy"');
    expect(html).toContain('aria-label="Regenerate"');
  });

  it("renders no thumbs on the hidden stub, even when its Run ended", () => {
    const html = renderInChat(createElement(MessageRow, { message: reply(true), actions }));

    expect(html).not.toContain('aria-label="Good reply"');
    expect(html).not.toContain('aria-label="Bad reply"');
  });

  it("renders a reply that is not hidden as before, with its text and Copy", () => {
    const html = renderInChat(createElement(MessageRow, { message: reply(false), actions }));

    expect(html).toContain("Forbidden words");
    expect(html).not.toContain("This reply was hidden");
    expect(html).toContain('aria-label="Copy"');
  });
});
