import { type ConnectionsHost, ConnectionsSection } from "@botsdk/ui/mcp";
import {
  CredentialsSections,
  ImageModelSelect,
  KeySettingsPage,
  type LinkedCredentialsHost,
} from "@botsdk/ui/models";
import { LinkedIdentitiesSection } from "@botsdk/ui/settings/linked-identities-section";
import { NotificationsSection } from "@botsdk/ui/settings/notifications-section";
import { createFileRoute } from "@tanstack/react-router";

import { getChatgptLinkEnabled } from "@/functions/chatgpt-link-enabled";
import { connectionProviders, unlinkConnection } from "@/connections";
import { authClient } from "@/lib/auth-client";
import { unlinkChatgpt } from "@/unlink-chatgpt";

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
    // Better Auth unlinks by account row id, so every ChatGPT row is found first.
    const { data: accounts, error: listError } = await authClient.listAccounts();
    if (listError) throw new Error(listError.message);
    await unlinkChatgpt(accounts ?? [], async (accountId) => {
      const { error } = await authClient.unlinkAccount({ accountId });
      if (error) throw new Error(error.message);
    });
  },
};

// Connections (ADR 0037) are link-only Better Auth providers, like ChatGPT: Connect and Reconnect
// send the browser to the app and back to this page. Disconnect only removes the account row.
const connections: ConnectionsHost = {
  connect: async (key) => {
    const provider = connectionProviders[key];
    if (!provider) throw new Error(`No Connection "${key}" is declared`);
    const { error } = await authClient.linkSocial({ provider, callbackURL: "/settings/keys" });
    if (error) throw new Error(error.message);
  },
  disconnect: async (key) => {
    // Better Auth unlinks by account row id, so the Connection's rows are found first.
    const { data: accounts, error: listError } = await authClient.listAccounts();
    if (listError) throw new Error(listError.message);
    await unlinkConnection(accounts ?? [], key, async (accountId) => {
      const { error } = await authClient.unlinkAccount({ accountId });
      if (error) throw new Error(error.message);
    });
  },
};

export const Route = createFileRoute("/_auth/settings/keys")({
  loader: () => getChatgptLinkEnabled(),
  component: KeysRoute,
});

function KeysRoute() {
  const linkEnabled = Route.useLoaderData();
  return (
    <KeySettingsPage>
      <CredentialsSections linkedCredentials={linkEnabled ? chatgpt : undefined} />
      <ConnectionsSection host={connections} />
      <ImageModelSelect />
      <NotificationsSection />
      <LinkedIdentitiesSection />
    </KeySettingsPage>
  );
}
