import { createElement } from "react";
import { renderEnglish as renderToStaticMarkup } from "../fake-dictionary";
import { describe, expect, it } from "vitest";

import { TemporaryHeaderActions } from "../../../plugins/assistant/ui/shell/conversation-header-actions";

describe("the chat header in a Temporary Conversation", () => {
  it("offers Delete and no Share", () => {
    const html = renderToStaticMarkup(
      createElement(TemporaryHeaderActions, { onDelete: () => {} }),
    );

    expect(html).toContain('aria-label="Delete Conversation"');
    expect(html).not.toContain('aria-label="Share"');
  });
});
