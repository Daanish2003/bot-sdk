import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { AppShell } from "../../../plugins/assistant/ui/shell/app-shell";
import { renderWrapped } from "../fake-dictionary";

describe("the install prompt slot", () => {
  it("renders the Host's installPrompt at the bottom of the drawer", () => {
    const html = renderWrapped(
      createElement(AppShell, {
        children: "page",
        installPrompt: createElement("p", null, "Install slot"),
      }),
    );

    const drawer = html.indexOf('id="app-drawer"');
    const panel = html.indexOf('aria-label="Conversations"', drawer);
    const slot = html.indexOf("Install slot");
    const topBar = html.indexOf("<header");

    expect(drawer).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(panel);
    expect(slot).toBeLessThan(topBar);
  });

  it("renders the drawer without the slot when the Host passes none", () => {
    const html = renderWrapped(createElement(AppShell, { children: "page" }));

    expect(html).not.toContain("Install slot");
    expect(html).toContain('id="app-drawer"');
  });
});
