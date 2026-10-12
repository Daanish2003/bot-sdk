import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { contextFill } from "../../../core/client/context-ring";
import { ContextOverflowNotice, ContextRing } from "../../../ui/chat/context-ring";

describe("ContextRing", () => {
  it("is hidden when there is no reading (no Run, or an unknown window)", () => {
    expect(renderToStaticMarkup(createElement(ContextRing, { fill: null }))).toBe("");
    expect(contextFill(5000, null)).toBeNull();
  });

  it("is neutral below 80%, amber from 80% and red from 95%", () => {
    const html = (tokens: number) =>
      renderToStaticMarkup(createElement(ContextRing, { fill: contextFill(tokens, 10000) }));
    expect(html(7999)).toContain("text-muted-foreground");
    expect(html(8000)).toContain("text-amber-500");
    expect(html(9500)).toContain("text-destructive");
    expect(html(9500)).toContain('aria-label="Context: 9,500 of 10,000 tokens (95%)"');
  });

  it("names the exact tokens and the window (the accessible name, and the tooltip on hover)", () => {
    const html = renderToStaticMarkup(
      createElement(ContextRing, { fill: contextFill(3400, 128000) }),
    );
    expect(html).toContain("3,400 of 128,000 tokens (3%)");
  });
});

describe("ContextOverflowNotice", () => {
  it("warns only when the Conversation is over the window", () => {
    expect(
      renderToStaticMarkup(
        createElement(ContextOverflowNotice, { fill: contextFill(9000, 10000) }),
      ),
    ).toBe("");
    const html = renderToStaticMarkup(
      createElement(ContextOverflowNotice, { fill: contextFill(12000, 10000) }),
    );
    expect(html).toContain("Earlier Messages will be dropped");
  });
});
