import type { UIMessage } from "@tanstack/ai-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageRow } from "../../../ui/chat/message-row";
import { ReadAloudButton } from "../../../ui/chat/read-aloud";

const reply = (status: "complete" | "streaming") =>
  ({
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", content: "Hello there." }],
    createdAt: new Date("2026-10-13T10:00:00Z"),
    metadata: {
      model: null,
      status,
      error: null,
      errorReason: null,
      usage: null,
      contextStartId: null,
    },
  }) as unknown as UIMessage;

const actions = {
  streaming: false,
  model: "",
  onEdit: () => {},
  onRegenerate: () => {},
  onSwitchBranch: () => {},
  onRate: () => {},
};

describe("the read-aloud button", () => {
  it("offers Read aloud while idle and Stop reading while speaking", () => {
    expect(
      renderToStaticMarkup(createElement(ReadAloudButton, { speaking: false, onToggle: () => {} })),
    ).toContain('aria-label="Read aloud"');
    expect(
      renderToStaticMarkup(createElement(ReadAloudButton, { speaking: true, onToggle: () => {} })),
    ).toContain('aria-label="Stop reading"');
  });
});

describe("the read-aloud control on a reply", () => {
  // The browser's voices are read in an effect, which a static render never runs. So no
  // server render offers the control, and the shared page never does either.
  it("is absent on a finished reply when no on-device voice is known", () => {
    const html = renderToStaticMarkup(
      createElement(MessageRow, { message: reply("complete"), actions }),
    );

    expect(html).toContain('aria-label="Copy"');
    expect(html).not.toContain("Read aloud");
  });

  it("is absent on a Shared link page, which passes no actions", () => {
    const html = renderToStaticMarkup(createElement(MessageRow, { message: reply("complete") }));

    expect(html).not.toContain("Read aloud");
  });
});
