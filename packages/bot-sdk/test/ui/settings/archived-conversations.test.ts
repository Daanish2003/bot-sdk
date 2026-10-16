import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createBotSdkClient } from "../../../core/client/chat-client";
import { assistantClient } from "../../../plugins/assistant/client/index";
import { modelsClient } from "../../../plugins/models/client/index";
import {
  ChatProvider,
  type ChatLinkProps,
  type ChatRouter,
} from "../../../core/client/react/provider";
import { ArchivedConversationsSection } from "../../../plugins/assistant/ui/settings/archived-conversations";

const client = createBotSdkClient({
  plugins: [modelsClient(), assistantClient()],
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children, className }: ChatLinkProps) => createElement("a", { className }, children),
  navigate: () => {},
  useLocation: () => ({ newConversation: false }),
  shareUrl: (token) => token,
};

/** One archived Conversation as the `archived` procedure returns it. */
function archivedRow(id: string, title: string) {
  return {
    id,
    title,
    model: "anthropic:claude-sonnet-5-5",
    lastMessageAt: new Date("2026-10-01T09:00:00Z"),
    pinnedAt: null,
    archivedAt: new Date("2026-10-02T09:00:00Z"),
    projectId: null,
    preview: "",
    hasError: false,
    shared: false,
  };
}

/** Renders the section with the first page of the Archived list seeded as `items`. */
function renderArchived(items: ReturnType<typeof archivedRow>[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    client.orpc.conversation.archived.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }).queryKey,
    { pages: [{ items, nextCursor: null }], pageParams: [undefined] },
  );
  return renderToStaticMarkup(
    createElement(ChatProvider, {
      client,
      router,
      queryClient,
      children: createElement(ArchivedConversationsSection),
    }),
  );
}

describe("the Archived Conversations section of the settings", () => {
  it("says so when nothing is archived, and still offers Archive all", () => {
    const html = renderArchived([]);

    expect(html).toContain("Archived Conversations");
    expect(html).toContain("You haven&#x27;t archived any Conversations.");
    expect(html).toContain("Archive all");
    expect(html).not.toContain("Unarchive");
  });

  it("lists each archived Conversation with Open, Unarchive and Delete", () => {
    const html = renderArchived([
      archivedRow("0190a000-0000-7000-8000-000000000001", "Kubernetes notes"),
      archivedRow("0190a000-0000-7000-8000-000000000002", "Tax questions"),
    ]);

    expect(html).toContain("Kubernetes notes");
    expect(html).toContain("Tax questions");
    expect(html).toContain(">Open</a>");
    expect(html).toContain("Unarchive");
    expect(html).toContain("Delete");
    expect(html).not.toContain("You haven&#x27;t archived any Conversations.");
  });
});
