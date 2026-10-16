import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createBotSdkClient } from "../../core/client/chat-client";
import { assistantClient } from "../../plugins/assistant/client/index";
import { modelsClient } from "../../plugins/models/client/index";
import { type ChatRouter, ChatProvider } from "../../core/client/react/provider";
import type { Messages } from "../../core/shared/i18n";

const client = createBotSdkClient({
  plugins: [modelsClient(), assistantClient()],
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children }) => createElement("a", null, children),
  navigate: () => {},
  useLocation: () => ({ newConversation: false }),
  shareUrl: (token) => token,
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
