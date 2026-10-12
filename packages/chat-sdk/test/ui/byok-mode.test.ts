import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createChatClient } from "../../core/client/chat-client";
import {
  ChatProvider,
  type ChatLinkProps,
  type ChatRouter,
} from "../../core/client/react/provider";
import { MissingCredentialsBanner } from "../../ui/chat/missing-credentials-banner";
import { NoCredentials } from "../../ui/chat/no-credentials";
import { KeySettingsPage } from "../../ui/pages/key-settings";

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

/** Renders `ui` with the mode seeded (`undefined`: not yet known, as on first paint). */
function render(ui: ReturnType<typeof createElement>, byok: boolean | undefined) {
  const queryClient = new QueryClient();
  if (byok !== undefined) {
    queryClient.setQueryData(client.orpc.credentials.mode.queryKey(), { byok });
  }
  queryClient.setQueryData(client.orpc.credentials.list.queryKey(), []);
  return renderToStaticMarkup(
    createElement(ChatProvider, { client, router, queryClient, children: ui }),
  );
}

describe("the key prompts with byok on", () => {
  it("shows the key settings link on the missing-credentials banner", () => {
    const html = render(
      createElement(MissingCredentialsBanner, { message: "Pick another Model" }),
      true,
    );

    expect(html).toContain("Pick another Model.");
    expect(html).toContain("Key settings");
  });

  it("shows the add-key empty state for a user with no Models", () => {
    expect(render(createElement(NoCredentials), true)).toContain("Add Provider credentials");
  });

  it("shows the Providers and Tools sections on the keys page", () => {
    const html = render(createElement(KeySettingsPage), true);

    expect(html).toContain("Providers");
    expect(html).toContain("Tools");
  });
});

describe("the key prompts with byok off", () => {
  it("renders no key settings link on the missing-credentials banner", () => {
    const html = render(
      createElement(MissingCredentialsBanner, { message: "Pick another Model" }),
      false,
    );

    expect(html).toContain("Pick another Model.");
    expect(html).not.toContain("Key settings");
  });

  it("renders no add-key empty state", () => {
    const html = render(createElement(NoCredentials), false);

    expect(html).not.toContain("Add Provider credentials");
    expect(html).not.toContain("Bring your own key");
  });

  it("omits the Providers and Tools sections of the keys page", () => {
    const html = render(createElement(KeySettingsPage), false);

    expect(html).not.toContain("Providers");
    expect(html).not.toContain("Tools");
    expect(html).not.toContain("Add");
  });

  it("hides the prompts until the mode is known", () => {
    const html = render(
      createElement(MissingCredentialsBanner, { message: "Pick another Model" }),
      undefined,
    );

    expect(html).not.toContain("Key settings");
  });
});
