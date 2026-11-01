import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "@/components/ui/prompt-kit/markdown";

const html = (source: string) => renderToStaticMarkup(createElement(Markdown, null, source));

describe("Markdown asterisks", () => {
  it("keeps asterisks between ASCII letters or digits literal", () => {
    expect(html("2*3*4")).toContain("2*3*4");
    expect(html("2*3*4")).not.toContain("<em>");
    expect(html("a**b**c")).toContain("a**b**c");
    expect(html("a**b**c")).not.toContain("<strong>");
  });

  it("still emphasises at word edges", () => {
    expect(html("*yes* and **bold**")).toContain("<em>yes</em>");
    expect(html("*yes* and **bold**")).toContain("<strong>bold</strong>");
  });
});
