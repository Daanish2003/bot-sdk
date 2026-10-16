import type { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
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
import { ArtifactCard } from "../../../ui/chat/artifact-card";
import {
  ArtifactPanel,
  ArtifactPanelView,
  LiveArtifactView,
} from "../../../ui/chat/artifact-panel";
import { liveArtifactOf } from "../../../ui/chat/artifact-live";
import { GeneratedImageBlock } from "../../../ui/chat/generated-image-block";
import { Dictation } from "../../../ui/chat/dictation";
import { ReadAloudButton } from "../../../ui/chat/read-aloud";
import { SavedPromptFormView, SlashMenuList } from "../../../ui/chat/slash-menu";
import { TemporaryHeaderActions } from "../../../ui/shell/conversation-header-actions";
import type { ListedModel } from "../../../plugins/models/shared/models";
import { createI18n } from "../../../core/shared/i18n";
import type { GeneratedImagePart } from "../../../plugins/assistant/shared/message-parts";
import { toolCallOf, type ToolCallView } from "../../../plugins/assistant/shared/chat/tool-call";
import { renderWrapped, untranslated, wrappedDictionary } from "../fake-dictionary";

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

const seedAll = (queryClient: QueryClient, client: BotSdkClient) => {
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
  seed?: (queryClient: QueryClient, client: BotSdkClient) => void,
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

  it("shows no untranslated text in a Temporary Conversation's Delete action", () => {
    const html = expectTranslated(createElement(TemporaryHeaderActions, { onDelete: () => {} }));

    expect(html).toContain("⟦Delete Conversation⟧");
  });

  it("shows no untranslated text on the read-aloud control in both states", () => {
    expectTranslated(createElement(ReadAloudButton, { speaking: false, onToggle: () => {} }));
    const speaking = expectTranslated(
      createElement(ReadAloudButton, { speaking: true, onToggle: () => {} }),
    );

    expect(speaking).toContain("⟦Stop reading⟧");
  });

  it("shows no untranslated text on the / menu, its create row and its form", () => {
    const prompts = [{ name: "review", text: "Review this code for bugs first." }];
    const list = expectTranslated(
      createElement(SlashMenuList, {
        prompts,
        query: "",
        loaded: true,
        active: 0,
        onHover: () => {},
        onPick: () => {},
      }),
      undefined,
      ["/review", "Review this code for bugs first."],
    );
    expect(list).toContain("⟦Saved prompts⟧");

    const empty = expectTranslated(
      createElement(SlashMenuList, {
        prompts: [],
        query: "xyz",
        loaded: true,
        active: 0,
        onHover: () => {},
        onPick: () => {},
      }),
    );
    expect(empty).toContain(
      "⟦No Saved prompts yet. Save text you send often and insert it with /name.⟧",
    );
    expect(empty).toContain("⟦Create /xyz…⟧");

    const form = expectTranslated(
      createElement(SavedPromptFormView, {
        name: "",
        onName: () => {},
        text: "",
        onText: () => {},
        status: "⟦Saves, then inserts it.⟧",
        canSave: false,
        saving: false,
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );
    expect(form).toContain("⟦New Saved prompt⟧");
  });

  it("shows no untranslated text on the mic at the Quota limit, and when it is ready", () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => {} } });
    vi.stubGlobal("MediaRecorder", class {});
    try {
      const off = expectTranslated(
        createElement(Dictation, { onTranscript: () => {} }),
        (queryClient, client) => {
          queryClient.setQueryData(client.orpc.voice.status.queryOptions().queryKey, {
            transcription: { available: true, onHostCredentials: true },
          });
          seedAll(queryClient, client);
        },
      );
      expect(off).toContain("⟦Dictation off until ");

      const ready = expectTranslated(
        createElement(Dictation, { onTranscript: () => {} }),
        (queryClient, client) => {
          queryClient.setQueryData(client.orpc.voice.status.queryOptions().queryKey, {
            transcription: { available: true, onHostCredentials: false },
          });
        },
      );
      expect(ready).toContain("⟦Dictate⟧");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows no untranslated text on a generated image in each state", () => {
    const image = (fields: Record<string, unknown>) =>
      ({
        type: "generated_image",
        prompt: "A lighthouse at dusk",
        aspectRatio: "square",
        state: "done",
        imageId: "img-1",
        ...fields,
      }) as unknown as GeneratedImagePart;
    const imagesUrl = "http://localhost/api/chat/generated-images";
    const allow = ["A lighthouse at dusk"];

    expectTranslated(
      createElement(GeneratedImageBlock, { image: image({ state: "running" }), imagesUrl }),
      undefined,
      allow,
    );
    expectTranslated(
      createElement(GeneratedImageBlock, {
        image: image({ state: "error", errorReason: "refused" }),
        imagesUrl,
      }),
      undefined,
      allow,
    );
    expectTranslated(
      createElement(GeneratedImageBlock, { image: image({ state: "cancelled" }), imagesUrl }),
      undefined,
      allow,
    );
    expectTranslated(
      createElement(GeneratedImageBlock, {
        image: image({}),
        imagesUrl,
        editedFrom: [{ label: "Harbour" }],
      }),
      undefined,
      [...allow, "Harbour"],
    );
  });

  it("shows no untranslated text on an Artifact card in each state", () => {
    const allow = ["Landing page"];
    const onOpen = () => {};
    const saved = expectTranslated(
      createElement(ArtifactCard, { call: artifactCall(doneFields), messageId: "m-1", onOpen }),
      undefined,
      allow,
    );
    expect(saved).toContain("⟦Created v1");
    expectTranslated(
      createElement(ArtifactCard, { call: artifactCall({}), messageId: "m-1", onOpen }),
      undefined,
      allow,
    );
    expectTranslated(
      createElement(ArtifactCard, {
        call: artifactCall({
          state: "output-error",
          output: { error: "Input validation failed" },
          metadata: { source: "builtin", status: "error" },
        }),
        messageId: "m-1",
        onOpen,
      }),
      undefined,
      allow,
    );
    const update = expectTranslated(
      createElement(ArtifactCard, {
        call: artifactCall({
          name: "update_artifact",
          arguments: JSON.stringify({ artifactId: "abc" }),
          input: { artifactId: "abc" },
        }),
        messageId: "m-1",
        latestVersion: 1,
        onOpen,
      }),
      undefined,
      allow,
    );
    expect(update).toContain("⟦Updating to v2…⟧");
  });

  it("shows no untranslated text in the Artifact panel's views and its loading state", () => {
    const version = {
      number: 2,
      title: "Landing page",
      kind: "html" as const,
      language: null,
      content: "<h1>Hi</h1>",
    };
    const versions = [
      { artifactId: "abc", version: 2, messageId: "m-2" },
      { artifactId: "abc", version: 1, messageId: "m-1" },
    ];
    const allow = ["Landing page", "<h1>Hi</h1>"];
    const panel = expectTranslated(
      createElement(ArtifactPanelView, {
        version,
        versions,
        onClose: () => {},
        onSelect: () => {},
      }),
      undefined,
      allow,
    );
    expect(panel).toContain("⟦v2 (latest)⟧");
    expectTranslated(
      createElement(ArtifactPanelView, {
        version: { ...version, kind: "code", language: "html" },
        onClose: () => {},
        readOnly: true,
      }),
      undefined,
      [...allow, "Shared link · read-only"],
    );
    expectTranslated(
      createElement(LiveArtifactView, {
        title: "Landing page",
        kind: "html",
        language: null,
        source: "<h1>",
        notice: "⟦This Artifact wasn't saved⟧",
        onClose: () => {},
      }),
      undefined,
      ["Landing page", "<h1>"],
    );
    expectTranslated(
      createElement(ArtifactPanel, {
        artifact: { artifactId: "abc", version: 2, messageId: "m-2" },
        onClose: () => {},
      }),
    );
  });

  it("gives the Artifact call's notice and title through the dictionary", () => {
    const i18n = createI18n(wrappedDictionary());
    const live = liveArtifactOf(
      i18n,
      artifactCall({
        state: "output-error",
        output: { error: "x" },
        metadata: { source: "builtin", status: "error" },
      }),
    );

    expect(live.notice).toBe("⟦This Artifact wasn't saved⟧");
    expect(liveArtifactOf(i18n, artifactCall({ arguments: "{}", input: {} })).title).toBe(
      "⟦Artifact⟧",
    );
  });
});

const doneFields = {
  state: "complete",
  output: { artifactId: "abc", version: 1 },
  metadata: { source: "builtin", status: "done" },
};

/** An `create_artifact` call with its arguments: the title is the card's text. */
function artifactCall(fields: Record<string, unknown>): ToolCallView {
  const call = toolCallOf({
    type: "tool-call",
    id: "call-1",
    name: "create_artifact",
    arguments: JSON.stringify({ kind: "html", title: "Landing page" }),
    input: { kind: "html", title: "Landing page" },
    state: "input-complete",
    metadata: { source: "builtin", status: "running" },
    ...fields,
  } as never);
  if (!call) throw new Error("Expected a tool call");
  return call;
}
