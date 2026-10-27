import { createBotSdkClient } from "@botsdk/client";
import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ChatProvider,
  type ChatLinkProps,
  type ChatRouter,
} from "../../core/client/react/provider";
import { HostKeysPage } from "./host-keys-page";

const client = createBotSdkClient({
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children, className }: ChatLinkProps) => createElement("a", { className }, children),
  navigate: () => {},
};

/** Renders `ui` with the mode seeded (`undefined`: not yet known, as on first paint). */
function render(ui: ReturnType<typeof createElement>, byok: boolean | undefined) {
  const queryClient = new QueryClient();
  if (byok !== undefined) {
    queryClient.setQueryData(client.orpc.models.credentials.mode.queryKey(), { byok });
  }
  queryClient.setQueryData(client.orpc.models.credentials.list.queryKey(), []);
  return renderToStaticMarkup(
    createElement(ChatProvider, { client, router, queryClient, children: ui }),
  );
}

describe("the keys page with byok on", () => {
  it("shows the Providers and Tools sections", () => {
    const html = render(createElement(HostKeysPage), true);

    expect(html).toContain("Providers");
    expect(html).toContain("Tools");
  });
});

describe("the keys page with byok off", () => {
  it("omits the Providers and Tools sections", () => {
    const html = render(createElement(HostKeysPage), false);

    expect(html).not.toContain("Providers");
    expect(html).not.toContain("Tools");
    expect(html).not.toContain("Add");
  });

  it("hides them until the mode is known", () => {
    const html = render(createElement(HostKeysPage), undefined);

    expect(html).not.toContain("Providers");
    expect(html).not.toContain("Tools");
  });
});
