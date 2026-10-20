import { createElement } from "react";
import { describe, expect, it } from "vitest";

import type { MessageUsage } from "../../../plugins/models/shared/usage";
import { UsageBreakdown } from "../../../plugins/models/ui/chat/usage-info";
import { renderInChat } from "../../support/chat-provider";

const render = (usage: MessageUsage) => renderInChat(createElement(UsageBreakdown, { usage }));

describe("a reply's token popover", () => {
  it("lists the exact input, output, reasoning and cached tokens, with no estimate note", () => {
    const html = render({
      input: 1200,
      output: 340,
      reasoning: 90,
      cached: 800,
      cacheWrite: 0,
      estimated: false,
    });

    expect(html).toContain("Input");
    expect(html).toContain("1,200");
    expect(html).toContain("Output");
    expect(html).toContain("340");
    expect(html).toContain("Reasoning");
    expect(html).toContain("90");
    expect(html).toContain("Cached");
    expect(html).toContain("800");
    expect(html).not.toContain("Estimate");
  });

  it("marks an estimate as one", () => {
    const html = render({
      input: 12,
      output: 8,
      reasoning: 0,
      cached: 0,
      cacheWrite: 0,
      estimated: true,
    });

    expect(html).toContain("Estimate: the Provider reported no usage for this reply.");
  });

  it("shows tokens only, never cost", () => {
    const html = render({
      input: 12,
      output: 8,
      reasoning: 0,
      cached: 0,
      cacheWrite: 0,
      estimated: false,
    });

    expect(html).not.toMatch(/cost|\$|€|£/i);
  });
});
