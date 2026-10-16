import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";

import { createBotSdkClient } from "../../../core/client/chat-client";
import { ChatProvider, type ChatRouter } from "../../../core/client/react/provider";
import { Composer } from "../../../ui/chat/composer";

const client = createBotSdkClient({
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children, className }) => createElement("a", { className }, children),
  navigate: () => {},
  useLocation: () => ({ newConversation: false }),
  shareUrl: (token) => token,
};

/** The composer inside the chat's provider, which its dictation mic reads (spec #249). */
function render(composer: ReactElement) {
  return renderToStaticMarkup(
    createElement(ChatProvider, {
      client,
      router,
      queryClient: new QueryClient(),
      children: composer,
    }),
  );
}

describe("the composer after a refused Message", () => {
  it("keeps the text the user sent and shows the reason", () => {
    const html = render(
      createElement(Composer, {
        onSend: () => {},
        value: "Please rephrase me",
        onValueChange: () => {},
        refusal: "Off-policy request",
      }),
    );

    expect(html).toContain("Please rephrase me");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Off-policy request");
  });

  it("shows no alert when nothing was refused", () => {
    const html = render(
      createElement(Composer, { onSend: () => {}, value: "", onValueChange: () => {} }),
    );

    expect(html).not.toContain('role="alert"');
  });
});
