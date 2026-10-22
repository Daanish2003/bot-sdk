// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { botClient } from "../../../plugins/bot/client/index";
import { BotSkillChip } from "../../../plugins/skills/ui/bot-skill-chip";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const plugins = [botClient()];

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
        { messages: {}, plugins },
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
          plugins,
        }),
      );
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });
});
