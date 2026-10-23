"use client";

import { useChatAdapter } from "@ai-chat/bot-sdk/core/client";
import type { SharedConversation as SharedSnapshot } from "@ai-chat/bot-sdk/plugins/assistant/shared/share/conversation";
import {
  ArchivedConversationsSection,
  BackgroundModelSelect,
  ChatView,
  ConnectionsSection,
  DeleteAllConversationsSection,
  ImageModelSelect,
  InstructionsField,
  NewConversationPage,
  ProjectPage,
  SavedPromptsSection,
  SharedConversationPage,
  SharedLinksSection,
  type SharedViewer,
  SharedLinkNotFound as SdkSharedLinkNotFound,
  YourDataSection,
} from "@ai-chat/bot-sdk/plugins/assistant/ui";
import { MemorySection } from "@ai-chat/bot-sdk/plugins/memory/ui";
import { CredentialsSections, KeySettingsPage } from "@ai-chat/bot-sdk/plugins/models/ui";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

export function NewConversation() {
  return <NewConversationPage />;
}

export function ProjectRoute({ id }: { id: string }) {
  return <ProjectPage key={id} projectId={id} />;
}

export function KeySettings() {
  const { plugins } = useChatAdapter();
  return (
    <KeySettingsPage>
      <CredentialsSections />
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

export function SharedConversation({
  data,
  viewer,
}: {
  data: SharedSnapshot;
  viewer: SharedViewer;
}) {
  return <SharedConversationPage data={data} viewer={viewer} />;
}

export function SharedLinkNotFound() {
  return <SdkSharedLinkNotFound />;
}

/** Loads the Conversation in the browser, then shows it. `message` is a search hit to land on. */
export function ConversationRoute({ id, message }: { id: string; message?: string }) {
  const { orpc } = useChatAdapter();
  const router = useRouter();
  const { data, error } = useQuery(orpc.conversation.get.queryOptions({ input: { id } }));
  if (error) {
    return (
      <p className="p-6 text-sm text-muted-foreground">This Conversation can&apos;t be opened.</p>
    );
  }
  if (!data) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  return (
    <ChatView
      key={id}
      conversation={data}
      focusMessageId={message}
      onFocused={() => router.replace(`/c/${encodeURIComponent(id)}`)}
    />
  );
}
