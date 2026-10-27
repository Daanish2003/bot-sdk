import { createBotSdkClient } from "@botsdk/client";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { type ChatRouter, ChatProvider } from "../../core/client/react/provider";
import type { Messages } from "../../core/shared/i18n";

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

/** Server-renders `ui` inside a ChatProvider, with the Host's dictionary and locale when given. */
export function renderInChat(
  ui: ReactNode,
  options: { locale?: string; messages?: Partial<Messages> } = {},
) {
  return renderToStaticMarkup(
    createElement(ChatProvider, { client, router, ...options, children: ui }),
  );
}
