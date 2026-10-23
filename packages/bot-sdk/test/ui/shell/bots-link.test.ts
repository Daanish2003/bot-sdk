import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { AppShell } from "../../../plugins/assistant/ui/shell/app-shell";
import { assistantClient } from "../../../plugins/assistant/client/index";
import { botClient } from "../../../plugins/bot/client/index";
import { modelsClient } from "../../../plugins/models/client/index";
import { renderWrapped } from "../fake-dictionary";

const base = [modelsClient(), assistantClient()];

describe("the shell's Bots link", () => {
  it("shows when the Host enables the bot plugin", () => {
    const html = renderWrapped(createElement(AppShell, { children: "page" }), {
      plugins: [...base, botClient()],
    });

    expect(html).toContain("lucide-bot");
  });

  it("is hidden when the Host does not", () => {
    const html = renderWrapped(createElement(AppShell, { children: "page" }), { plugins: base });

    expect(html).not.toContain("lucide-bot");
  });
});
