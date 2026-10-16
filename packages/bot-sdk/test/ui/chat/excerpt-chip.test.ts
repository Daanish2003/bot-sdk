// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createBotSdkClient } from "../../../core/client/chat-client";
import { ChatProvider, type ChatRouter } from "../../../core/client/react/provider";
import type { Citation } from "../../../plugins/assistant/shared/chat/sources";
import { Markdown } from "@/components/ui/prompt-kit/markdown";
import { replyComponents, replyKeepUrl, ReplySources } from "../../../ui/chat/source-chips";
import { untranslated, wrappedDictionary } from "../fake-dictionary";

/*
 * An Excerpt's chip in a reply (spec #357, ticket #206): a numbered chip whose click opens a
 * popover with the file name and passage. On a Shared link there is no passage to show.
 */

afterEach(() => cleanup());

const client = createBotSdkClient({
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children }) => createElement("a", null, children),
  navigate: () => {},
  useLocation: () => ({ newConversation: false }),
  shareUrl: (token) => token,
};

const citations: Citation[] = [
  { number: 1, url: "https://tanstack.com/ai", title: "TanStack AI", snippet: "Docs" },
  { number: 2, label: "excerpt:1", fileName: "brief.md", text: "The budget is 5,000." },
];

const reply =
  "The budget is 5,000 ([brief.md](excerpt:1)). Tools exist ([tanstack](https://tanstack.com/ai)).";

function mount(messages?: ReturnType<typeof wrappedDictionary>, found: Citation[] = citations) {
  const replyMarkdown = createElement(
    ReplySources.Provider,
    { value: found },
    createElement(Markdown, {
      components: replyComponents,
      keepUrl: replyKeepUrl,
      children: reply,
    }),
  );
  return render(
    createElement(ChatProvider, {
      client,
      router,
      ...(messages && { messages }),
      children: replyMarkdown,
    }),
  );
}

describe("an Excerpt chip", () => {
  it("is numbered with the reply's Sources and never links to the file", () => {
    mount();

    expect(screen.getByRole("button", { name: "Excerpt 2" }).textContent).toBe("2");
    expect(document.querySelector('a[href="excerpt:1"]')).toBeNull();
  });

  it("opens a popover with the file name and passage when clicked", async () => {
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Excerpt 2" }));

    expect(await screen.findByText("brief.md")).toBeTruthy();
    expect(screen.getByText("The budget is 5,000.")).toBeTruthy();
  });

  it("shows only the file name on a Shared link, which carries no passage", async () => {
    mount(undefined, [{ number: 1, label: "excerpt:1", fileName: "brief.md" }]);

    fireEvent.click(screen.getByRole("button", { name: "Excerpt 1" }));

    expect(await screen.findByText("brief.md")).toBeTruthy();
    expect(document.body.textContent).not.toContain("The budget is 5,000.");
  });

  it("shows no untranslated text in its label or popover", async () => {
    mount(wrappedDictionary());

    fireEvent.click(screen.getByRole("button", { name: "⟦Excerpt 2⟧" }));
    await screen.findByText("brief.md");

    // The reply's own sentences and the file's name and passage are content, not copy.
    const content = [
      "brief.md",
      "The budget is 5,000.",
      "The budget is 5,000 (",
      "). Tools exist (",
    ];
    expect(untranslated(document.body.innerHTML, [...content, "2", "tanstack"])).toEqual([]);
  });
});

describe("an Excerpt link the reply has no Excerpt for", () => {
  it("keeps its text without a link", () => {
    render(
      createElement(
        ReplySources.Provider,
        { value: citations },
        createElement(Markdown, {
          components: replyComponents,
          keepUrl: replyKeepUrl,
          children: "See [missing.md](excerpt:9).",
        }),
      ),
    );

    expect(document.body.textContent).toContain("missing.md");
    expect(document.querySelector("a")).toBeNull();
  });
});
