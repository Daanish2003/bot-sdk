// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { BotSkillChip } from "@botsdk/ui/skills/bot-skill-chip";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

describe("BotSkillChip", () => {
  it("shows a chip per Skill, saved or updated", () => {
    render(
      providerFor(
        createElement(BotSkillChip, {
          botId: "ada",
          changes: [
            { kind: "saved", name: "weekly-report" },
            { kind: "updated", name: "expense-sheet" },
          ],
        }),
        { messages: {} },
      ),
    );

    expect(screen.getByText("📘 Skill saved: weekly-report")).toBeTruthy();
    expect(screen.getByText("📘 Skill updated: expense-sheet")).toBeTruthy();
  });

  it("shows nothing when the Turn wrote no Skill", () => {
    for (const none of [null, []]) {
      const { container, unmount } = render(
        providerFor(createElement(BotSkillChip, { botId: "ada", changes: none }), {
          messages: {},
        }),
      );
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });
});
