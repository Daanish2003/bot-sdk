import { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createChatClient, type ChatClient } from "../../core/client/chat-client";
import {
  type ChatLinkProps,
  ChatProvider,
  type ChatLocation,
  type ChatRouter,
} from "../../core/client/react/provider";
import { en, type Messages } from "../../core/shared/i18n";

/**
 * A Host dictionary whose every value wraps the English in ⟦ ⟧. Text the UI shows from the
 * dictionary comes out wrapped; text that is still hard-coded doesn't.
 */
export function wrappedDictionary(): Partial<Messages> {
  const entries = Object.entries(en).map(([key, value]) => [
    key,
    typeof value === "string"
      ? `⟦${value}⟧`
      : (params: never) => `⟦${(value as (params: never) => string)(params)}⟧`,
  ]);
  return Object.fromEntries(entries) as Partial<Messages>;
}

const wrapped = /⟦[^⟧]*⟧/g;

/**
 * The visible text and labels (`aria-label`, `title`, `placeholder`, `alt`) in rendered markup that
 * are not wrapped in ⟦ ⟧, so they were not translated. `allow` lists user content, and copy owned
 * by a surface outside the test.
 */
export function untranslated(html: string, allow: string[] = []): string[] {
  const attributes = [...html.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map(
    (match) => decode(match[1] ?? ""),
  );
  const text = html
    .replace(/<[^>]*>/g, "\n")
    .split("\n")
    .map(decode);
  return [...attributes, ...text]
    .map((piece) => {
      const rest = piece.replace(wrapped, "").trim();
      return allow.includes(rest) ? "" : rest;
    })
    .filter((piece) => /\p{L}/u.test(piece));
}

function decode(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}

/**
 * Renders `ui` inside a ChatProvider with the English dictionary, for render tests that check the
 * English text. A component that reads the dictionary needs the provider around it.
 */
export function renderEnglish(ui: ReactElement): string {
  return renderWrapped(ui, { messages: {} });
}

/** Renders `ui` inside a ChatProvider with the fake dictionary, seeding its queries from `seed`. */
export function renderWrapped(
  ui: ReactElement,
  {
    seed,
    location = {},
    messages = wrappedDictionary(),
  }: {
    seed?: (queryClient: QueryClient, client: ChatClient) => void;
    location?: Partial<ChatLocation>;
    messages?: Partial<Messages>;
  } = {},
) {
  const client = createChatClient({
    baseUrl: "http://localhost/api/chat",
    fetch: async () => {
      throw new Error("Unexpected request in a render test");
    },
  });
  const router: ChatRouter = {
    Link: ({ children, className }: ChatLinkProps) => createElement("a", { className }, children),
    navigate: () => {},
    useLocation: () => ({ newConversation: false, ...location }),
    shareUrl: (token) => token,
  };
  const queryClient = new QueryClient();
  seed?.(queryClient, client);
  return renderToStaticMarkup(
    createElement(ChatProvider, {
      client,
      router,
      queryClient,
      messages,
      children: ui,
    }),
  );
}
