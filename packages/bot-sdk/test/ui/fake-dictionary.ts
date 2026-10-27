import {
  type BotSdkClient,
  type CoreContract,
  createBotSdkClient,
  type FeatureClient,
  type FeaturesContract,
} from "@botsdk/client";
import { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChannelsClient } from "../../plugins/channel/client/index";
import type { KnowledgeFeatureClient } from "../../plugins/knowledge/client/index";
import type { McpFeatureClient } from "../../plugins/mcp/client/index";
import type { MemoryFeatureClient } from "../../plugins/memory/client/index";
import type { SkillsFeatureClient } from "../../plugins/skills/client/index";
import { type ChatLinkProps, BotSdkProvider, type ChatRouter } from "@botsdk/react/provider";
import { en, type Messages } from "@botsdk/client/i18n";

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

const wrapped = /⟦[^⟦⟧]*⟧/g;

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
      // A param can be wrapped inside its own message (⟦Delete ⟦2 Conversations⟧⟧): strip inside out.
      let rest = piece;
      while (/⟦[^⟦⟧]*⟧/.test(rest)) rest = rest.replace(wrapped, "");
      rest = rest.trim();
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
 * Renders `ui` inside a BotSdkProvider with the English dictionary, for render tests that check the
 * English text. A component that reads the dictionary needs the provider around it.
 */
export function renderEnglish(ui: ReactElement): string {
  return renderWrapped(ui, { messages: {} });
}

/** Renders `ui` inside a BotSdkProvider with the fake dictionary, seeding its queries from `seed`. */
export function renderWrapped(ui: ReactElement, options: WrapOptions = {}) {
  return renderToStaticMarkup(providerFor(ui, options));
}

/** A client typed with every feature's contract. */
export type TestClient = BotSdkClient<
  CoreContract &
    FeaturesContract<
      [
        MemoryFeatureClient,
        SkillsFeatureClient,
        KnowledgeFeatureClient,
        McpFeatureClient,
        ChannelsClient,
      ]
    >
>;

type WrapOptions = {
  /** Seeds the cache; the client is typed with every feature, whichever the test enables. */
  seed?: (queryClient: QueryClient, client: TestClient) => void;
  /** The Host's navigation, to see where the UI goes. Defaults to going nowhere. */
  navigate?: ChatRouter["navigate"];
  messages?: Partial<Messages>;
  /** The features' client parts the Host enables. Defaults to none: the core alone. */
  features?: FeatureClient[];
  /** The network. Defaults to failing, since a render test makes no requests. */
  fetch?: NonNullable<Parameters<typeof createBotSdkClient>[0]["fetch"]>;
};

/**
 * The BotSdkProvider tree around `ui`, with the fake dictionary, for a client-rendered (jsdom) test
 * to mount with RTL. `renderWrapped` renders the same tree to static markup.
 */
export function providerFor(
  ui: ReactElement,
  {
    seed,
    navigate = () => {},
    messages = wrappedDictionary(),
    features = [],
    fetch = async () => {
      throw new Error("Unexpected request in a render test");
    },
  }: WrapOptions = {},
) {
  const client = createBotSdkClient({
    features,
    baseUrl: "http://localhost/api/chat",
    fetch,
  });
  const router: ChatRouter = {
    Link: ({ children, className }: ChatLinkProps) => createElement("a", { className }, children),
    navigate,
  };
  const queryClient = new QueryClient();
  seed?.(queryClient, client as unknown as TestClient);
  return createElement(BotSdkProvider, {
    client,
    router,
    queryClient,
    messages,
    children: ui,
  });
}
