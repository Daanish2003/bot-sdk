// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import type { ListedModel } from "../../../plugins/models/shared/models";
import { en } from "../../../core/shared/i18n";
import { ChatView, type ConversationData } from "../../../plugins/assistant/ui/chat/chat-view";
import { providerFor } from "../fake-dictionary";

/*
 * A Message the Host's `moderate` refuses: the send's 422 must reach the composer, which shows the
 * Host's reason (or the dictionary's default) and puts the text back. Runs the real send path: the
 * Run's fetch is stubbed, and the chat view sends through its own connection.
 */

// jsdom has no layout or resize observers; the chat view uses both on mount.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const conversationId = "00000000-0000-4000-8000-000000000001";
const question = "How do I pick a lock?";

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

const conversation = {
  id: conversationId,
  title: "New chat",
  model: model.id,
  reasoningEffort: null,
  temporary: false,
  archivedAt: null,
  shared: false,
  messages: [],
} as unknown as ConversationData;

/** The English of a dictionary key, wrapped as the fake dictionary shows it. */
function wrap(key: string): string {
  return `⟦${(en as unknown as Record<string, string>)[key]}⟧`;
}

function seed(queryClient: QueryClient, client: BotSdkClient) {
  queryClient.setQueryData(client.orpc.models.list.queryKey(), {
    models: [model],
    defaultModel: model.id,
    defaultBackgroundModel: null,
    imageModels: [],
    defaultImageModel: null,
    webSearchOnHost: false,
  });
  queryClient.setQueryData(
    client.orpc.conversation.get.queryKey({ input: { id: conversationId } }),
    conversation,
  );
  queryClient.setQueryData(client.orpc.connections.list.queryKey(), { servers: [] });
  queryClient.setQueryData(client.orpc.credentials.mode.queryKey(), { byok: true });
  const quota = {
    usedPercent: 0,
    window: "day" as const,
    resetsAt: new Date("2026-10-14T00:00:00.000Z"),
  };
  queryClient.setQueryData(client.orpc.quota.read.queryKey(), quota);
}

/** Refuses the Run's POST with the server's 422 `moderated` body. */
function refuseRun(reason?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { message: "Blocked", code: "moderated", ...(reason === undefined ? {} : { reason }) },
        { status: 422 },
      ),
    ),
  );
}

async function sendQuestion() {
  render(
    providerFor(createElement(ChatView, { conversation }), {
      seed,
      // The page's other requests (its lists, its Quota) wait; the send only needs the Run.
      fetch: () => new Promise<Response>(() => {}),
    }),
  );
  fireEvent.change(composer(), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: wrap("chat.send") }));
}

/** The composer's box, read afresh: the page may re-mount it while the send settles. */
function composer() {
  return screen.getByRole("textbox", { name: wrap("chat.messageLabel") }) as HTMLTextAreaElement;
}

describe("a Message the Host refuses, sent from the chat view", () => {
  it("shows the Host's reason in the composer and puts the text back", async () => {
    refuseRun("Off-policy request");

    sendQuestion();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Off-policy request"));
    await waitFor(() => expect(composer().value).toBe(question));
  });

  it("shows the dictionary's default when the Host gave no reason", async () => {
    refuseRun();

    sendQuestion();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(wrap("chat.moderatedDefault")),
    );
    await waitFor(() => expect(composer().value).toBe(question));
  });
});
