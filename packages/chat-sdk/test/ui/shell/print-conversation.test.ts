import type { MessagePart } from "@tanstack/ai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createChatClient } from "../../../core/client/chat-client";
import { toolCallOf } from "../../../core/shared/chat/tool-call";
import { ChatProvider, type ChatRouter } from "../../../core/client/react/provider";
import { Composer } from "../../../ui/chat/composer";
import { ToolCallRow } from "../../../ui/chat/tool-call-row";
import { ConversationMenuItems, TopBar } from "../../../ui/shell/top-bar";
import { renderInChat } from "../../support/chat-provider";

const router: ChatRouter = {
  Link: () => null,
  navigate: () => {},
  useLocation: () => ({ newConversation: false, pageTitle: "Keys" }),
  shareUrl: () => "",
};

/** The renders here make no requests; the Composer's Saved prompts query only runs when the menu opens. */
const client = createChatClient({
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

describe("printing a Conversation", () => {
  it("offers Print / Save as PDF in the Conversation menu, beside Export as Markdown", () => {
    const markup = renderToStaticMarkup(
      createElement(ConversationMenuItems, { onExport: () => {}, onPrint: () => {} }),
    );

    expect(markup).toContain("Print / Save as PDF");
    expect(markup).toContain("Export as Markdown");
  });

  it("hides the top bar when printing", () => {
    const bar = createElement(TopBar, {
      panelOpen: true,
      drawerOpen: false,
      onOpenPanel: () => {},
      onOpenDrawer: () => {},
      onOpenSearch: () => {},
    });
    const markup = renderToStaticMarkup(
      createElement(ChatProvider, { client, router, children: bar }),
    );

    expect(markup).toMatch(/<header class="[^"]*print:hidden[^"]*"/);
  });

  it("hides the composer when printing", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatProvider, {
        client,
        router,
        children: createElement(Composer, { onSend: () => {} }),
      }),
    );

    expect(markup).toContain("print:hidden");
  });

  it("renders a collapsed tool call's arguments and result for print", () => {
    const part = {
      type: "tool-call",
      id: "call-1",
      name: "server_time",
      arguments: JSON.stringify({ zone: "UTC" }),
      input: { zone: "UTC" },
      state: "complete",
      output: { now: "noon" },
      metadata: { source: "host", status: "done" },
    } as MessagePart;
    const call = toolCallOf(part);
    if (!call) throw new Error("Expected a tool call");

    const markup = renderInChat(createElement(ToolCallRow, { call }));

    expect(markup).toContain("print:block");
    expect(markup).toContain("{&quot;zone&quot;:&quot;UTC&quot;}");
  });
});
