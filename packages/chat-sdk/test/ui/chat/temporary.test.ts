import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TemporaryBanner } from "../../../ui/chat/temporary-banner";
import { TemporaryToggle } from "../../../ui/chat/temporary-toggle";

describe("the Temporary toggle", () => {
  it("is labelled Temporary and reports whether it is on", () => {
    const off = renderToStaticMarkup(
      createElement(TemporaryToggle, { on: false, onChange: () => {} }),
    );
    const on = renderToStaticMarkup(
      createElement(TemporaryToggle, { on: true, onChange: () => {} }),
    );

    expect(off).toContain("Temporary");
    expect(off).toContain('aria-pressed="false"');
    expect(on).toContain('aria-pressed="true"');
  });
});

describe("the Temporary banner", () => {
  it("says the chat isn't saved, and when it is deleted", () => {
    const html = renderToStaticMarkup(createElement(TemporaryBanner));

    expect(html).toContain(
      "Temporary chat: not saved to your history or Memory; deleted 30 days after the last message",
    );
  });
});
