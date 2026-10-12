import type { UIMessage } from "@tanstack/ai-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { contextCutIds } from "../../../core/client/chat";
import { MessageRow } from "../../../ui/chat/message-row";

const marker = "Earlier messages are no longer in the model's context";

/** A UI Message with the metadata `toUIMessages` gives it, and no parts needed for the marker. */
function uiMessage(id: string, role: "user" | "assistant", contextStartId: string | null = null) {
  return {
    id,
    role,
    parts: [{ type: "text", content: id }],
    createdAt: new Date("2026-10-10T10:00:00Z"),
    metadata: {
      model: null,
      status: "complete",
      error: null,
      errorReason: null,
      usage: null,
      contextStartId,
    },
  } as unknown as UIMessage;
}

describe("the context marker (#122)", () => {
  it("sits above the context-start Message on the Branch the reply belongs to", () => {
    const branch = [
      uiMessage("u0", "user"),
      uiMessage("a0", "assistant"),
      uiMessage("u1", "user"),
      uiMessage("a1", "assistant", "u1"),
    ];

    expect([...contextCutIds(branch)]).toEqual(["u1"]);
  });

  it("shows no marker on another Branch of the same Conversation", () => {
    // The sibling Branch replaces u1 with u2, so its reply has no cut-off of its own.
    const otherBranch = [
      uiMessage("u0", "user"),
      uiMessage("a0", "assistant"),
      uiMessage("u2", "user"),
      uiMessage("a2", "assistant"),
    ];

    expect(contextCutIds(otherBranch).size).toBe(0);
  });

  it("ignores a context start that is not on the Branch shown", () => {
    const branch = [uiMessage("u2", "user"), uiMessage("a2", "assistant", "u1")];

    expect(contextCutIds(branch).size).toBe(0);
  });

  it("renders the marker above a Message only when it is the cut", () => {
    // React escapes the apostrophe in "model's" as an entity in the static markup.
    const render = (contextCut: boolean) =>
      renderToStaticMarkup(
        createElement(MessageRow, { message: uiMessage("u1", "user"), contextCut }),
      ).replaceAll("&#x27;", "'");
    const cut = render(true);
    const plain = render(false);

    expect(cut.indexOf(marker)).toBeGreaterThanOrEqual(0);
    // Above the Message's own text, which is rendered as `>u1<`.
    expect(cut.indexOf(marker)).toBeLessThan(cut.indexOf(">u1<"));
    expect(plain).not.toContain(marker);
  });
});
