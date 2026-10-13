import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SlashMenuList } from "../../../ui/chat/slash-menu";

const prompts = [
  { name: "review", text: "\n  Review this code for bugs first.\nThen readability." },
  { name: "standup", text: "Turn these notes into a standup update." },
];

function render(props: Partial<Parameters<typeof SlashMenuList>[0]>) {
  return renderToStaticMarkup(
    createElement(SlashMenuList, {
      prompts,
      query: "",
      loaded: true,
      active: 0,
      onHover: () => {},
      onPick: () => {},
      ...props,
    }),
  );
}

describe("the / menu's rows", () => {
  it("shows one row per matching Saved prompt, its name and first line, then the create row", () => {
    const markup = render({});

    expect(markup).toContain("/review");
    expect(markup).toContain("Review this code for bugs first.");
    expect(markup).toContain("/standup");
    expect(markup.match(/role="option"/g)).toHaveLength(3);
    expect(markup).toContain("New Saved prompt…");
    expect(markup.indexOf("/review")).toBeLessThan(markup.indexOf("New Saved prompt…"));
  });

  it("filters the rows by the query, and offers to create the typed name when none match", () => {
    const markup = render({ query: "xyz" });

    expect(markup).not.toContain("/review");
    expect(markup).toContain("Create /xyz…");
    expect(markup.match(/role="option"/g)).toHaveLength(1);
  });

  it("highlights the active row only", () => {
    const markup = render({ active: 1 });

    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup).toContain('aria-selected="true"');
  });

  it("shows the empty state when the user has no Saved prompts", () => {
    const markup = render({ prompts: [], query: "" });

    expect(markup).toContain(
      "No Saved prompts yet. Save text you send often and insert it with /name.",
    );
    expect(markup).toContain("New Saved prompt…");
  });

  it("shows no empty state while the list is still loading", () => {
    expect(render({ prompts: [], loaded: false })).not.toContain("No Saved prompts yet");
  });
});
