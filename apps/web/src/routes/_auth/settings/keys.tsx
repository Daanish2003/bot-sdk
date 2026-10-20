import { KeySettingsPage, type LinkedCredentialsHost } from "@ai-chat/bot-sdk/plugins/models/ui";
import { createFileRoute } from "@tanstack/react-router";

import { authClient } from "@/lib/auth-client";

// ChatGPT is link-only (ADR 0023): Better Auth sends the browser to ChatGPT and back to this page.
const chatgpt: LinkedCredentialsHost = {
  connect: async () => {
    const { error } = await authClient.linkSocial({
      provider: "chatgpt",
      callbackURL: "/settings/keys",
    });
    if (error) throw new Error(error.message);
  },
  disconnect: async () => {
    const { error } = await authClient.unlinkAccount({ providerId: "chatgpt" });
    if (error) throw new Error(error.message);
  },
};

export const Route = createFileRoute("/_auth/settings/keys")({
  component: () => <KeySettingsPage linkedCredentials={chatgpt} />,
});
