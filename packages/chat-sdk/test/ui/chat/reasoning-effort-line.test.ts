import { renderInChat } from "../../support/chat-provider";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { EffortLine } from "../../../ui/chat/usage-info";

describe("the info popover's effort line", () => {
  it("shows the effort the reply ran with", () => {
    const html = renderInChat(createElement(EffortLine, { reasoningEffort: "high" }));

    expect(html).toContain("Reasoning effort: ");
    expect(html).toContain("High");
  });

  it("reads a reply that ran on the Model's default as the default", () => {
    const html = renderInChat(createElement(EffortLine, { reasoningEffort: null }));

    expect(html).toContain("Model default");
  });
});
