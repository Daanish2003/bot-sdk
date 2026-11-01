// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ResetDivider } from "../../src/bot/bot-menu";
import { CheckInLine } from "../../src/bot/check-in-line";
import { RunDivider } from "../../src/bot/run-divider";
import { WarmLine } from "../../src/bot/warm-line";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const at = new Date(2026, 9, 21, 14, 10);

describe("the lines in a thread", () => {
  it("share the one divider style", () => {
    const { container } = render(
      providerFor(
        createElement("div", null, [
          createElement(ResetDivider, { key: "reset" }),
          createElement(RunDivider, { key: "run", name: "n", at, quiet: false, webhook: false }),
          createElement(WarmLine, { key: "warm", warming: { id: "w1", costMicros: 0 } as never }),
          createElement(CheckInLine, {
            key: "check",
            checkIn: { id: "c1", at, note: "x", state: "pending" } as never,
            onCancelCheckIn: async () => {},
            actingCheckIns: new Set<string>(),
          }),
        ]),
        { messages: {} },
      ),
    );

    const lines = container.querySelectorAll(
      "[data-reset-mark], [data-run], [data-warming], [data-check-in]",
    );
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line.hasAttribute("data-approval-settled")).toBe(true);
    expect(container.querySelector("[data-check-in] button")?.textContent).toBe("Cancel");
  });
});
