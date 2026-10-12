"use client";

import { useChatAdapter } from "@/chat-sdk/core/client";
import type { SharedConversation as SharedSnapshot } from "@/chat-sdk/core/shared/share/conversation";
import {
  ChatView,
  KeySettingsPage,
  NewConversationPage,
  ProjectPage,
  SharedConversationPage,
  type SharedViewer,
  SharedLinkNotFound as SdkSharedLinkNotFound,
} from "@/chat-sdk/ui";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

export function NewConversation() {
  return <NewConversationPage />;
}

export function ProjectRoute({ id }: { id: string }) {
  return <ProjectPage key={id} projectId={id} />;
}

export function KeySettings() {
  return <KeySettingsPage />;
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
