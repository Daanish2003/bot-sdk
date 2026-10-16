import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "@/components/ui/prompt-kit/markdown";

describe("Markdown images", () => {
  it("drops a remote image: no <img> or preload link fetches the remote source, only its alt text shows", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, null, "![x](https://attacker.example/a.png)"),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("attacker.example");
    expect(html).toContain("x");
  });

  it("never turns a data: image into a network request", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, null, "![y](data:image/png;base64,iVBORw0KGgo=)"),
    );
    expect(html).not.toContain("<link");
    expect(html).not.toContain("https://");
  });
});
