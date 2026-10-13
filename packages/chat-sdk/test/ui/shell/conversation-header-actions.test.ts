import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TemporaryHeaderActions } from "../../../ui/shell/conversation-header-actions";

describe("the chat header in a Temporary Conversation", () => {
  it("offers Delete and no Share", () => {
    const html = renderToStaticMarkup(
      createElement(TemporaryHeaderActions, { onDelete: () => {} }),
    );

    expect(html).toContain('aria-label="Delete Conversation"');
    expect(html).not.toContain('aria-label="Share"');
  });
});
