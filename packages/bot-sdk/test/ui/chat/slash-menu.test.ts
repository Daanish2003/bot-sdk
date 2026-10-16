import { createElement } from "react";
import { renderEnglish as renderToStaticMarkup } from "../fake-dictionary";
import { describe, expect, it } from "vitest";

import { SavedPromptFormView, SlashMenuList } from "../../../ui/chat/slash-menu";

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

function renderForm(props: Partial<Parameters<typeof SavedPromptFormView>[0]>) {
  return renderToStaticMarkup(
    createElement(SavedPromptFormView, {
      name: "",
      onName: () => {},
      text: "",
      onText: () => {},
      status: "Saves, then inserts it.",
      canSave: true,
      saving: false,
      onSubmit: () => {},
      onCancel: () => {},
      ...props,
    }),
  );
}

describe("the create form in the / menu", () => {
  it("prefills the name field from the query and offers a text field, Save and Cancel", () => {
    const markup = renderForm({ name: "xyz" });

    expect(markup).toContain('value="xyz"');
    expect(markup).toContain('aria-label="Text"');
    expect(markup).toContain(">Save</button>");
    expect(markup).toContain(">Cancel</button>");
  });

  it("shows the server's message in the form and keeps Save disabled while it is shown", () => {
    const markup = renderForm({
      name: "review",
      status: 'You already have a Saved prompt named "review"',
      canSave: false,
    });

    expect(markup).toContain("You already have a Saved prompt named &quot;review&quot;");
    expect(markup).toMatch(/disabled=""[^>]*>Save/);
  });

  it("shows why a draft can't be saved, such as blank text", () => {
    const markup = renderForm({ name: "eli5", status: "Text can't be blank", canSave: false });

    expect(markup).toContain("Text can&#x27;t be blank");
    expect(markup).not.toContain("Saves, then inserts it.");
  });
});
