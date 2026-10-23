// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, Fragment, type ReactElement } from "react";
import { Toaster } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotSdkClient } from "../../core/client/chat-client";
import type { ListedModel } from "../../plugins/models/shared/models";
import { en } from "../../core/shared/i18n";
import { ChatView, type ConversationData } from "../../plugins/assistant/ui/chat/chat-view";
import { ProjectPage } from "../../plugins/assistant/ui/pages/project";
import { CommandPalette } from "../../plugins/assistant/ui/shell/command-palette";
import { TopBar } from "../../plugins/assistant/ui/shell/top-bar";
import { ShareDialog } from "../../plugins/assistant/ui/share/share-dialog";
import { DeleteAllConversationsSection } from "../../plugins/assistant/ui/settings/delete-all-conversations";
import { providerFor, untranslated } from "./fake-dictionary";

/*
 * The surfaces that only render once opened: a dialog, a popover, the palette's rename input, a
 * toast. They mount with RTL in jsdom, open through the UI, and check the page the way the
 * server-rendered i18n tests do: no English text is left outside the fake dictionary's ⟦ ⟧.
 */

const conversationId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";

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
  reasoning: { efforts: [], off: false, defaultEffort: null },
};

/** Text the dictionary doesn't translate: the user's own content, Model names and data. */
const ownedContent = ["Trip planning", "Thesis", "Claude Haiku 4.5", "Anthropic", "tok-1"];

/**
 * Text outside the dictionary that these surfaces show, and which is left as it is: the shadcn
 * dialog's own close label (packages/ui owns it; it has no prop for one), the word the user types
 * to confirm a delete-all, and the keyboard key the top bar shows on Windows and Linux.
 */
const chromeText = ["Close", "DELETE", "Ctrl+K"];

// jsdom has no layout or resize observers; the components use both on mount.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

/** The English of a key as the fake dictionary shows it: wrapped in ⟦ ⟧, with its params filled in. */
function wrap(key: string, params?: Record<string, unknown>): string {
  const value = (en as unknown as Record<string, unknown>)[key];
  const text =
    typeof value === "function"
      ? (value as (params?: Record<string, unknown>) => string)(params)
      : (value as string);
  return `⟦${text}⟧`;
}

/** Mounts `ui` in the document with the fake dictionary. */
function mount(ui: ReactElement, options: Parameters<typeof providerFor>[1] = {}) {
  return render(providerFor(ui, options));
}

function untranslatedOnPage(allow: string[] = [...ownedContent, ...chromeText]) {
  return untranslated(document.body.innerHTML, allow);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const conversationDetail = {
  id: conversationId,
  title: "Trip planning",
  model: model.id,
  reasoningEffort: null,
  temporary: false,
  archivedAt: null,
  shared: false,
  messages: [],
};

function seedShare(link: { token: string; title: string; updatedAt: Date } | null) {
  return (queryClient: QueryClient, client: BotSdkClient) => {
    queryClient.setQueryData(
      client.orpc.share.forConversation.queryKey({ input: { conversationId } }),
      {
        link,
        movedOn: false,
        blockedBy: null,
      },
    );
    queryClient.setQueryData(
      client.orpc.conversation.get.queryKey({ input: { id: conversationId } }),
      conversationDetail,
    );
  };
}

const conversationListKey = (client: BotSdkClient) =>
  client.orpc.conversation.list.infiniteOptions({
    input: (cursor: string | undefined) => ({ cursor }),
    initialPageParam: undefined,
    getNextPageParam: () => undefined,
  }).queryKey;

/** The palette's and the top bar's lists: a Conversation in the panel, a Model and a Project. */
function seedPalette(queryClient: QueryClient, client: BotSdkClient) {
  const conversation = {
    id: conversationId,
    title: "Trip planning",
    model: model.id,
    lastMessageAt: new Date(),
    preview: "Where to next",
    pinnedAt: null,
    projectId: null,
    shared: false,
    hasError: false,
  };
  queryClient.setQueryData(client.orpc.models.list.queryKey(), {
    models: [model],
    defaultModel: null,
    defaultBackgroundModel: null,
    imageModels: [],
    defaultImageModel: null,
    webSearchOnHost: false,
  });
  queryClient.setQueryData(client.orpc.project.list.queryKey(), {
    items: [{ id: projectId, name: "Thesis" }],
  });
  queryClient.setQueryData(client.orpc.conversation.pinned.queryKey(), []);
  queryClient.setQueryData(conversationListKey(client), {
    pages: [{ items: [conversation], nextCursor: null }],
    pageParams: [undefined],
  });
  queryClient.setQueryData(
    client.orpc.conversation.get.queryKey({ input: { id: conversationId } }),
    conversationDetail,
  );
}

describe("the open surfaces with the dictionary", () => {
  it("shows no untranslated text in the share dialog, open with no link", () => {
    mount(createElement(ShareDialog, { conversationId, open: true, onOpenChange: () => {} }), {
      seed: seedShare(null),
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.body.textContent).toContain(wrap("share.title", { title: "Trip planning" }));
    expect(document.body.textContent).toContain(wrap("share.createLink"));
    expect(untranslatedOnPage()).toEqual([]);
  });

  it("shows no untranslated text in the share dialog, open with a link", () => {
    mount(createElement(ShareDialog, { conversationId, open: true, onOpenChange: () => {} }), {
      seed: seedShare({ token: "tok-1", title: "Trip planning", updatedAt: new Date() }),
    });

    expect(screen.getByRole("button", { name: wrap("share.copyLink") })).toBeTruthy();
    expect(document.body.textContent).toContain(wrap("share.deleteLink"));
    expect(untranslatedOnPage()).toEqual([]);
  });

  it("shows no untranslated text in the delete-project confirmation", async () => {
    mount(createElement(ProjectPage, { projectId }), {
      seed: (queryClient, client) => {
        queryClient.setQueryData(client.orpc.project.get.queryKey({ input: { id: projectId } }), {
          id: projectId,
          name: "Thesis",
          defaultModel: null,
          instructions: null,
        });
        queryClient.setQueryData(
          client.orpc.project.conversationCount.queryKey({ input: { id: projectId } }),
          {
            count: 2,
          },
        );
        queryClient.setQueryData(
          client.orpc.conversation.list.infiniteOptions({
            input: (cursor: string | undefined) => ({ cursor, projectId }),
            initialPageParam: undefined,
            getNextPageParam: () => undefined,
          }).queryKey,
          { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] },
        );
      },
    });

    fireEvent.click(screen.getByRole("button", { name: wrap("pages.deleteProject") }));

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(document.body.textContent).toContain(wrap("pages.cancel"));
    expect(untranslatedOnPage()).toEqual([]);
  });

  it("shows no untranslated text in the delete-all confirmation", async () => {
    mount(createElement(DeleteAllConversationsSection));

    fireEvent.click(screen.getByRole("button", { name: wrap("settings.deleteAllTitle") }));

    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(document.body.textContent).toContain(wrap("settings.deleteAllConfirmBody"));
    expect(untranslatedOnPage()).toEqual([]);
  });

  it("shows no untranslated text in the command palette body, with its Conversation commands", () => {
    mount(createElement(CommandPalette, { open: true, onOpenChange: () => {} }), {
      location: { conversationId },
      seed: seedPalette,
    });

    expect(screen.getByText(wrap("shell.archiveThisConversation"))).toBeTruthy();
    expect(screen.getByText(wrap("shell.exportMarkdown"))).toBeTruthy();
    expect(screen.getByText(wrap("shell.printSaveAsPdf"))).toBeTruthy();
    expect(screen.getByText(wrap("shell.deleteThisConversation"))).toBeTruthy();
    expect(untranslatedOnPage()).toEqual([]);
  });

  it("shows no untranslated text in the palette's rename input", () => {
    mount(createElement(CommandPalette, { open: true, onOpenChange: () => {} }), {
      location: { conversationId },
      seed: seedPalette,
    });

    fireEvent.click(screen.getByText(wrap("shell.renameThisConversation")));

    expect(screen.getByLabelText(wrap("shell.newTitle"))).toBeTruthy();
    expect(untranslatedOnPage()).toEqual([]);
  });

  it("asks the window.confirm for the delete in translated text", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount(createElement(CommandPalette, { open: true, onOpenChange: () => {} }), {
      location: { conversationId },
      seed: seedPalette,
    });

    fireEvent.click(screen.getByText(wrap("shell.deleteThisConversation")));

    expect(confirm).toHaveBeenCalledTimes(1);
    const question = confirm.mock.calls[0]![0] as string;
    expect(question).toContain("⟦");
    expect(untranslated(question, ownedContent)).toEqual([]);
  });

  it("shows no untranslated text in the Conversation menu popover", async () => {
    mount(
      createElement(TopBar, {
        panelOpen: true,
        drawerOpen: false,
        onOpenPanel: () => {},
        onOpenDrawer: () => {},
        onOpenSearch: () => {},
      }),
      { location: { conversationId }, seed: seedPalette },
    );

    fireEvent.click(screen.getByRole("button", { name: wrap("shell.conversationMenu") }));

    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: wrap("shell.exportMarkdown") })).toBeTruthy();
    expect(untranslatedOnPage()).toEqual([]);
  });
});

/** A Conversation with one finished reply, for the reply's Rating and the composer's refusal. */
const chatConversation = {
  id: conversationId,
  title: "Trip planning",
  model: model.id,
  reasoningEffort: null,
  messages: [
    {
      id: "user-1",
      parentId: null,
      role: "user",
      parts: [{ type: "text", content: "Where are the best ramen shops?" }],
      attachments: [],
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
      parts: [{ type: "text", content: "Try Ichiran in Shibuya." }],
      attachments: [],
      model: model.id,
      reasoningEffort: null,
      status: "complete",
      error: null,
      errorReason: null,
      usage: null,
      contextStartId: null,
      createdAt: undefined,
      siblings: { index: 0, count: 1, previousId: null, nextId: null },
    },
  ],
} as unknown as ConversationData;

function seedChat(queryClient: QueryClient, client: BotSdkClient) {
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
    usedPercent: 0,
    window: "day" as const,
    resetsAt: new Date("2026-10-14T00:00:00.000Z"),
  };
  queryClient.setQueryData(client.orpc.quota.read.queryKey(), quota);
}

describe("the chat view's open surfaces with the dictionary", () => {
  it("shows the Rating toast in translated text when a Rating fails", async () => {
    // Every request fails, so the Rating call is refused.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    render(
      createElement(
        Fragment,
        null,
        providerFor(createElement(ChatView, { conversation: chatConversation }), {
          seed: seedChat,
        }),
        // The toast shows in the Toaster, which the page mounts once.
        createElement(Toaster),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: wrap("chat.goodReply") }));

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        wrap("chat.ratingFailed", { message: wrap("error.unexpected") }),
      ),
    );
    // The reply's own text, and Sonner's region label for the toasts.
    expect(
      untranslatedOnPage([
        ...ownedContent,
        ...chromeText,
        "Where are the best ramen shops?",
        "Try Ichiran in Shibuya.",
        "Notifications alt+T",
      ]),
    ).toEqual([]);
  });
});
