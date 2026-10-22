import { useChatAdapter } from "@ai-chat/bot-sdk/core/client";
import {
  ArchivedConversationsSection,
  BackgroundModelSelect,
  ConnectionsSection,
  DeleteAllConversationsSection,
  ImageModelSelect,
  InstructionsField,
  SavedPromptsSection,
  SharedLinksSection,
  YourDataSection,
} from "@ai-chat/bot-sdk/plugins/assistant/ui";
import { MemorySection } from "@ai-chat/bot-sdk/plugins/memory/ui";
import {
  CredentialsSections,
  KeySettingsPage,
  type LinkedCredentialsHost,
} from "@ai-chat/bot-sdk/plugins/models/ui";
import { createFileRoute } from "@tanstack/react-router";

import { getChatgptLinkEnabled } from "@/functions/chatgpt-link-enabled";
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

export const Route = createFileRoute("/_auth/settings/keys")({
  loader: () => getChatgptLinkEnabled(),
  component: KeysRoute,
});

function KeysRoute() {
  const linkEnabled = Route.useLoaderData();
  const { plugins } = useChatAdapter();
  return (
    <KeySettingsPage>
      <CredentialsSections linkedCredentials={linkEnabled ? chatgpt : undefined} />
      <ConnectionsSection />
      <SharedLinksSection />
      <ArchivedConversationsSection />
      <InstructionsField />
      {plugins.includes("memory") && <MemorySection />}
      <SavedPromptsSection />
      <BackgroundModelSelect />
      <ImageModelSelect />
      <YourDataSection />
      <DeleteAllConversationsSection />
    </KeySettingsPage>
  );
}
