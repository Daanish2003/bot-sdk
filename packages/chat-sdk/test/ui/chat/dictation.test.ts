import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createChatClient } from "../../../core/client/chat-client";
import { ChatProvider, type ChatRouter } from "../../../core/client/react/provider";
import { Composer } from "../../../ui/chat/composer";

const client = createChatClient({
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

/** The composer as the chat renders it, with the dictation status seeded (`undefined`: not loaded). */
function render(available: boolean | undefined) {
  const queryClient = new QueryClient();
  if (available !== undefined) {
    queryClient.setQueryData(client.orpc.voice.status.queryOptions().queryKey, {
      transcription: { available, onHostCredentials: false },
    });
  }
  return renderToStaticMarkup(
    createElement(ChatProvider, {
      client,
      router,
      queryClient,
      children: createElement(Composer, { onSend: () => {} }),
    }),
  );
}

describe("the dictation mic", () => {
  it("is hidden while the status is unknown", () => {
    const markup = render(undefined);
    expect(markup).not.toContain("Dictate");
    expect(markup).toContain('aria-label="Send"');
  });

  it("is hidden when no transcription is available", () => {
    expect(render(false)).not.toContain("Dictate");
  });

  it("is hidden in a browser that can't record, even when transcription is available", () => {
    // Server rendering has no MediaRecorder, which is the same as a browser without one.
    expect(render(true)).not.toContain("Dictate");
  });
});
