import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createBotSdkClient } from "../../../core/client/chat-client";
import { assistantClient } from "../../../plugins/assistant/client/index";
import { modelsClient } from "../../../plugins/models/client/index";
import { ChatProvider, type ChatRouter } from "../../../core/client/react/provider";
import { SavedPromptsSection } from "../../../plugins/assistant/ui/settings/saved-prompts";

const client = createBotSdkClient({
  plugins: [modelsClient(), assistantClient()],
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children, className }) => createElement("a", { className }, children),
  navigate: () => {},
  useLocation: () => ({ newConversation: false }),
  shareUrl: (token) => token,
};

/** One Saved prompt as the `list` procedure returns it. */
function savedPrompt(id: string, name: string, text: string) {
  return { id, name, text, createdAt: new Date("2026-10-01T09:00:00Z") };
}

/** Renders the section with the list seeded as `items`, so it renders without a request. */
function renderSection(items: ReturnType<typeof savedPrompt>[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(client.orpc.savedPrompt.list.queryOptions().queryKey, { items });
  return renderToStaticMarkup(
    createElement(ChatProvider, {
      client,
      router,
      queryClient,
      children: createElement(SavedPromptsSection),
    }),
  );
}

describe("SavedPromptsSection", () => {
  it("lists each Saved prompt as /name with the first line of its text", () => {
    const markup = renderSection([
      savedPrompt("p1", "review", "Review this code for bugs first.\nThen suggest fixes."),
      savedPrompt("p2", "formal", "Rewrite this formally."),
    ]);

    expect(markup).toContain("/review");
    expect(markup).toContain("Review this code for bugs first.");
    expect(markup).not.toContain("Then suggest fixes.");
    expect(markup).toContain("/formal");
    expect(markup).toContain("Rewrite this formally.");
  });

  it("offers to create one when there are none", () => {
    const markup = renderSection([]);

    expect(markup).toContain("You haven&#x27;t saved any Saved prompts yet.");
    expect(markup).toContain("New Saved prompt");
  });

  it("explains how a Saved prompt is inserted", () => {
    expect(renderSection([])).toContain("by typing its /name");
  });
});
