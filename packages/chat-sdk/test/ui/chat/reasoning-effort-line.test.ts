import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EffortLine } from "../../../ui/chat/usage-info";

describe("the info popover's effort line", () => {
  it("shows the effort the reply ran with", () => {
    const html = renderToStaticMarkup(createElement(EffortLine, { reasoningEffort: "high" }));

    expect(html).toContain("Reasoning effort: ");
    expect(html).toContain("High");
  });

  it("reads a reply that ran on the Model's default as the default", () => {
    const html = renderToStaticMarkup(createElement(EffortLine, { reasoningEffort: null }));

    expect(html).toContain("Model default");
  });
});
