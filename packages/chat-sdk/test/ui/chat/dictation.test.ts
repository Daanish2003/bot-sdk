import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { quotaResetsAt } from "../../../core/client/quota";
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

const resetsAt = new Date("2026-10-14T00:00:00.000Z");

/**
 * The composer as the chat renders it, with the dictation status and the Quota seeded (`undefined`:
 * not loaded).
 */
function render({
  available,
  onHostCredentials = false,
  usedPercent,
}: {
  available?: boolean;
  onHostCredentials?: boolean;
  usedPercent?: number;
}) {
  const queryClient = new QueryClient();
  if (available !== undefined) {
    queryClient.setQueryData(client.orpc.voice.status.queryOptions().queryKey, {
      transcription: { available, onHostCredentials },
    });
  }
  if (usedPercent !== undefined) {
    const quota = { usedPercent, window: "day" as const, resetsAt };
    queryClient.setQueryData(client.orpc.quota.read.queryKey(), quota);
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
    const markup = render({});
    expect(markup).not.toContain("Dictate");
    expect(markup).toContain('aria-label="Send"');
  });

  it("is hidden when no transcription is available", () => {
    expect(render({ available: false })).not.toContain("Dictate");
  });

  it("is hidden in a browser that can't record, even when transcription is available", () => {
    // Server rendering has no MediaRecorder, which is the same as a browser without one.
    expect(render({ available: true })).not.toContain("Dictate");
  });
});

describe("the dictation mic in a browser that can record", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Makes `AudioRecorder.isSupported()` true for the render, as in a browser with a microphone. */
  function stubRecording() {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => {} } });
    vi.stubGlobal("MediaRecorder", class {});
  }

  /** The mic button's opening tag, which carries `disabled` when it can't be pressed. */
  function micTag(markup: string): string {
    return markup.match(/<button[^>]*aria-label="Dictat[^"]*"[^>]*>/)?.[0] ?? "";
  }

  it("is enabled while the Quota is below its limit on Host credentials", () => {
    stubRecording();

    const tag = micTag(render({ available: true, onHostCredentials: true, usedPercent: 99 }));

    expect(tag).toContain('aria-label="Dictate"');
    expect(tag).not.toMatch(/\sdisabled=""/);
  });

  it("is disabled at the Quota limit on Host credentials, with the reset time", () => {
    stubRecording();

    const markup = render({ available: true, onHostCredentials: true, usedPercent: 100 });
    const tag = micTag(markup);

    expect(tag).toMatch(/\sdisabled=""/);
    expect(tag).toContain(`Dictation off until ${quotaResetsAt(resetsAt, "en")}`);
    expect(markup).toContain(quotaResetsAt(resetsAt, "en"));
  });

  it("stays enabled at the Quota limit on the caller's own key", () => {
    stubRecording();

    const tag = micTag(render({ available: true, onHostCredentials: false, usedPercent: 100 }));

    expect(tag).toContain('aria-label="Dictate"');
    expect(tag).not.toMatch(/\sdisabled=""/);
  });
});
