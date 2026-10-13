import type { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { ChatClient } from "../../../core/client/chat-client";
import { ChatView, type ConversationData } from "../../../ui/chat/chat-view";
import { Composer } from "../../../ui/chat/composer";
import { ContextRing, ContextOverflowNotice } from "../../../ui/chat/context-ring";
import { MessageRow } from "../../../ui/chat/message-row";
import { MissingCredentialsBanner } from "../../../ui/chat/missing-credentials-banner";
import { NoCredentials } from "../../../ui/chat/no-credentials";
import { AttachmentChips } from "../../../ui/chat/attachments";
import { QuotaBanner } from "../../../ui/chat/quota-banner";
import { QuotaMeter } from "../../../ui/chat/quota-meter";
import { SearchToggle } from "../../../ui/chat/search-toggle";
import { ToolsMenu } from "../../../ui/chat/tools-menu";
import { UsageBreakdown, UsageInfo } from "../../../ui/chat/usage-info";
import { Welcome } from "../../../ui/chat/welcome";
import { ShareButton } from "../../../ui/share/share-dialog";
import type { ListedModel } from "../../../core/shared/chat/models";
import { renderWrapped, untranslated } from "../fake-dictionary";

const model: ListedModel = {
  id: "anthropic:claude-haiku-4-5",
  label: "Claude Haiku 4.5",
  provider: "anthropic",
  modelId: "claude-haiku-4-5",
  images: true,
  pdfs: true,
  tools: true,
  contextWindow: 200_000,
  maxOutputTokens: null,
  onHostCredentials: true,
  reasoning: { efforts: ["low", "high"], off: true, defaultEffort: null },
};

/** Text the dictionary doesn't translate: the user's own content, Model and Provider names, and data. */
const ownedContent = [
  "Claude Haiku 4.5",
  "Anthropic",
  "Trip planning",
  "Where are the best ramen shops?",
  "trip.pdf",
  "Tavily",
  "server_time",
  "Ramen in Tokyo",
  "ramen.example.com",
  "A guide to ramen.",
  "Best ramen in Tokyo, ranked",
  "Ramen guide",
  "page",
  "ai",
];

const seedAll = (queryClient: QueryClient, client: ChatClient) => {
  queryClient.setQueryData(client.orpc.models.list.queryKey(), {
    models: [model],
    defaultModel: model.id,
    defaultBackgroundModel: null,
    imageModels: [],
    defaultImageModel: null,
    webSearchOnHost: true,
  });
  queryClient.setQueryData(client.orpc.credentials.mode.queryKey(), { byok: true });
  const quota = {
    usedPercent: 100,
    window: "day" as const,
    resetsAt: new Date("2026-10-14T00:00:00.000Z"),
  };
  queryClient.setQueryData(client.orpc.quota.read.queryKey(), quota);
};

const conversationId = "00000000-0000-4000-8000-000000000001";

/**
 * A Conversation with a user Message carrying an Attachment, and a reply that is still streaming:
 * a web search with Sources the text links to, a tool call, and some text.
 */
const conversation: ConversationData = {
  id: conversationId,
  title: "Trip planning",
  model: model.id,
  reasoningEffort: null,
  tools: { connections: [] },
  messages: [
    {
      id: "user-1",
      parentId: null,
      role: "user",
      parts: [{ type: "text", content: "Where are the best ramen shops?" }],
      attachments: [
        { id: "att-1", filename: "trip.pdf", mediaType: "application/pdf", size: 2048 },
      ],
      model: null,
      reasoningEffort: null,
      status: "complete",
      error: null,
      errorReason: null,
      usage: null,
      contextStartId: null,
      createdAt: undefined,
      siblings: { index: 0, count: 1, previousId: null, nextId: null },
    },
    {
      id: "assistant-1",
      parentId: "user-1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call-1",
          name: "web_search",
          arguments: JSON.stringify({ query: "ramen tokyo" }),
          input: { query: "ramen tokyo" },
          state: "complete",
          output: {
            results: [
              {
                title: "Best ramen in Tokyo, ranked",
                url: "https://ramen.example.com/tokyo",
                snippet: "A guide to ramen.",
              },
            ],
          },
          metadata: { source: "host", status: "done" },
        },
        {
          type: "text",
          content: "[Ramen in Tokyo](https://ramen.example.com/tokyo)",
        },
      ],
      attachments: [],
      model: model.id,
      reasoningEffort: null,
      status: "streaming",
      error: null,
      errorReason: null,
      usage: null,
      contextStartId: null,
      createdAt: undefined,
      siblings: { index: 0, count: 1, previousId: null, nextId: null },
    },
  ] as unknown as ConversationData["messages"],
} as unknown as ConversationData;

function expectTranslated(
  ui: ReactElement,
  seed?: (queryClient: QueryClient, client: ChatClient) => void,
  allow: string[] = [],
) {
  const html = renderWrapped(ui, { seed });
  expect(untranslated(html, [...ownedContent, ...allow])).toEqual([]);
  return html;
}

describe("the chat view with the dictionary", () => {
  it("shows no untranslated text in a streaming reply with a tool call, Sources, an Attachment and the Quota banner", () => {
    const html = expectTranslated(createElement(ChatView, { conversation }), seedAll);

    expect(html).toContain("⟦Quota used⟧");
    expect(html).toContain("⟦Message (Shift+Enter for a new line)⟧");
  });

  it("shows no untranslated text in a finished reply's row, with its actions", () => {
    const row = {
      ...conversation.messages[1]!,
      status: "complete",
    } as unknown as Parameters<typeof MessageRow>[0]["message"];
    expectTranslated(
      createElement(MessageRow, {
        message: row as never,
        actions: {
          streaming: false,
          model: model.id,
          onEdit: () => {},
          onRegenerate: () => {},
          onSwitchBranch: () => {},
          onRate: () => {},
        },
      }),
      seedAll,
    );
  });

  it("shows no untranslated text in an errored and a stopped reply", () => {
    const base = conversation.messages[1]!;
    expectTranslated(
      createElement(MessageRow, {
        message: { ...base, status: "error", errorReason: "rate_limited", error: null } as never,
      }),
      seedAll,
    );
    expectTranslated(
      createElement(MessageRow, {
        message: { ...base, status: "stopped", parts: [] } as never,
        contextCut: true,
      }),
      seedAll,
    );
  });

  it("shows no untranslated text in the composer, its attachments and the Tools and Web controls", () => {
    expectTranslated(
      createElement(Composer, {
        onSend: () => {},
        attachments: null,
        children: [
          createElement(ToolsMenu, {
            key: "tools",
            items: [{ key: "gh", name: "GitHub", on: true }],
            onToggle: () => {},
          }),
          createElement(SearchToggle, {
            key: "web",
            search: {
              available: true,
              enabled: true,
              on: true,
              setOn: () => {},
              tooltip: "Web on: search and read pages",
            },
          }),
        ],
      } as never),
    );
    expectTranslated(
      createElement(AttachmentChips, {
        attachments: [{ id: "a", filename: "trip.pdf", mediaType: "application/pdf", size: 2048 }],
      }),
    );
  });

  it("shows no untranslated text in the context ring, the usage popover and the Quota meter", () => {
    expectTranslated(
      createElement(ContextRing, {
        fill: {
          tokens: 150_000,
          window: 200_000,
          percent: 75,
          fraction: 0.75,
          level: "neutral",
          over: false,
        },
      }),
    );
    expectTranslated(
      createElement(ContextOverflowNotice, {
        fill: {
          tokens: 250_000,
          window: 200_000,
          percent: 125,
          fraction: 1,
          level: "red",
          over: true,
        },
      }),
    );
    expectTranslated(createElement(UsageInfo, { usage: null, reasoningEffort: "high" }));
    expectTranslated(
      createElement(UsageBreakdown, {
        usage: { input: 10, output: 5, reasoning: 0, cached: 0, estimated: true } as never,
      }),
    );
    expectTranslated(createElement(QuotaMeter), seedAll);
  });

  it("shows no untranslated text in the Quota banner and the missing-credentials banner", () => {
    expectTranslated(
      createElement(QuotaBanner, { resetsAt: new Date("2026-10-14T00:00:00.000Z") }),
      seedAll,
    );
    expectTranslated(
      createElement(MissingCredentialsBanner, { message: "⟦Pick another Model⟧" }),
      seedAll,
    );
  });

  it("shows no untranslated text on the welcome screen and the no-credentials states", () => {
    expectTranslated(createElement(Welcome, { onSuggest: () => {} }));
    expectTranslated(createElement(NoCredentials), seedAll);
    expectTranslated(createElement(NoCredentials), (queryClient, client) => {
      seedAll(queryClient, client);
      queryClient.setQueryData(client.orpc.credentials.mode.queryKey(), { byok: false });
    });
  });

  it("shows no untranslated text on the Share button", () => {
    expectTranslated(createElement(ShareButton, { conversationId }), seedAll);
  });
});
