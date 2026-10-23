import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createBotSdkClient } from "../../core/client/chat-client";
import {
  ChatProvider,
  type ChatLinkProps,
  type ChatRouter,
} from "../../core/client/react/provider";
import { modelsClient } from "../../plugins/models/client/index";
import { CredentialsSections, KeySettingsPage } from "../../plugins/models/ui/key-settings";

const client = createBotSdkClient({
  plugins: [modelsClient()],
  baseUrl: "http://localhost/api/chat",
  fetch: async () => {
    throw new Error("Unexpected request in a render test");
  },
});

const router: ChatRouter = {
  Link: ({ children, className }: ChatLinkProps) => createElement("a", { className }, children),
  navigate: () => {},
};

function render(children: ReturnType<typeof createElement>[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(client.orpc.credentials.mode.queryKey(), { byok: true });
  queryClient.setQueryData(client.orpc.credentials.list.queryKey(), []);
  return renderToStaticMarkup(
    createElement(ChatProvider, {
      client,
      router,
      queryClient,
      children: createElement(KeySettingsPage, null, ...children),
    }),
  );
}

describe("the Keys page", () => {
  it("renders exactly the sections the Host passes", () => {
    const html = render([
      createElement("section", { key: "a" }, "Host section A"),
      createElement(CredentialsSections, { key: "b" }),
      createElement("section", { key: "c" }, "Host section C"),
    ]);

    expect(html).toContain("Keys &amp; settings");
    expect(html).toContain("Host section A");
    expect(html).toContain("Host section C");
    expect(html.indexOf("Host section A")).toBeLessThan(html.indexOf("Providers"));
    expect(html.indexOf("Providers")).toBeLessThan(html.indexOf("Host section C"));
  });

  it("renders no section when the Host passes none", () => {
    const html = render([]);

    expect(html).not.toContain("Providers");
    expect(html).not.toContain("Tools");
    expect(html).not.toContain("<section");
  });
});
