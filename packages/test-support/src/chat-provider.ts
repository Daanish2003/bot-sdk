import { createBotSdkClient } from "@botsdk/client";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { type ChatRouter, BotSdkProvider } from "@botsdk/react/provider";
import type { Messages } from "@botsdk/client/i18n";

const client = createBotSdkClient({
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children }) => createElement("a", null, children),
  navigate: () => {},
};

/** Server-renders `ui` inside a BotSdkProvider, with the Host's dictionary and locale when given. */
export function renderInChat(
  ui: ReactNode,
  options: { locale?: string; messages?: Partial<Messages> } = {},
) {
  return renderToStaticMarkup(
    createElement(BotSdkProvider, { client, router, ...options, children: ui }),
  );
}
