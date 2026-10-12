import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createChatClient } from "../../../core/client/chat-client";
import {
  ChatProvider,
  type ChatLinkProps,
  type ChatRouter,
} from "../../../core/client/react/provider";
import { QuotaBanner } from "../../../ui/chat/quota-banner";
import { QuotaMeter } from "../../../ui/chat/quota-meter";
import { QuotaSlotProvider } from "../../../ui/shell/quota-slot";

const client = createChatClient({
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children, className }: ChatLinkProps) => createElement("a", { className }, children),
  navigate: () => {},
  useLocation: () => ({ newConversation: false }),
  shareUrl: (token) => token,
};

const resetsAt = new Date("2026-10-11T00:00:00.000Z");

/** A Quota read as `quota.read` answers it, at `usedPercent`. */
const quotaAt = (usedPercent: number) => ({ usedPercent, window: "day" as const, resetsAt });

/** Renders `ui` with the Quota read and the mode seeded (`quota: undefined`: not yet loaded). */
function render(
  ui: ReturnType<typeof createElement>,
  { quota, byok = true }: { quota?: ReturnType<typeof quotaAt> | null; byok?: boolean },
) {
  const queryClient = new QueryClient();
  if (quota !== undefined) {
    queryClient.setQueryData(client.orpc.quota.read.queryKey(), quota);
  }
  queryClient.setQueryData(client.orpc.credentials.mode.queryKey(), { byok });
  return renderToStaticMarkup(
    createElement(ChatProvider, { client, router, queryClient, children: ui }),
  );
}

describe("the Quota meter", () => {
  it("shows nothing below 80%", () => {
    expect(render(createElement(QuotaMeter), { quota: quotaAt(79) })).toBe("");
  });

  it("shows a percentage from 80%", () => {
    const html = render(createElement(QuotaMeter), { quota: quotaAt(80) });

    expect(html).toContain("80%");
    expect(html).toContain('role="meter"');
  });

  it("shows nothing for an unlimited Quota", () => {
    expect(render(createElement(QuotaMeter), { quota: null })).toBe("");
  });
});

describe("the banner at the limit", () => {
  it("shows the reset time", () => {
    const html = render(createElement(QuotaBanner, { resetsAt }), { quota: quotaAt(100) });

    expect(html).toContain("Host Models are off until");
    expect(html).toContain("Oct");
  });

  it("offers an Add your own key prompt when byok is on", () => {
    const html = render(createElement(QuotaBanner, { resetsAt }), {
      quota: quotaAt(100),
      byok: true,
    });

    expect(html).toContain("Add your own key");
  });

  it("offers no Add your own key prompt when byok is off", () => {
    const html = render(createElement(QuotaBanner, { resetsAt }), {
      quota: quotaAt(100),
      byok: false,
    });

    expect(html).not.toContain("Add your own key");
  });

  it("renders the Host's quotaExceeded slot", () => {
    const html = render(
      createElement(QuotaSlotProvider, {
        slot: createElement("span", null, "Plans from the Host"),
        children: createElement(QuotaBanner, { resetsAt }),
      }),
      { quota: quotaAt(100) },
    );

    expect(html).toContain("Plans from the Host");
  });
});
