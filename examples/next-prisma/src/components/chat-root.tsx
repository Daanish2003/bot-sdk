"use client";

import {
  type ChatLinkProps,
  type ChatLocation,
  type ChatPage,
  ChatProvider,
  type ChatRouter,
  createChatClient,
} from "@/chat-sdk/core/client";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useMemo } from "react";
import { Toaster } from "sonner";

// The browser calls the handler on its own origin. Server rendering makes no chat calls.
const chatClient = createChatClient({
  baseUrl:
    typeof window === "undefined"
      ? "http://localhost/api/chat"
      : `${window.location.origin}/api/chat`,
});

const pageTitles: Record<string, string> = { "/settings/keys": "Keys & settings" };

/** The app's route for each chat page. */
function hrefOf(page: ChatPage): string {
  switch (page.to) {
    case "new": {
      const params = new URLSearchParams();
      if (page.model) params.set("model", page.model);
      if (page.projectId) params.set("project", page.projectId);
      const query = params.toString();
      return query ? `/c?${query}` : "/c";
    }
    case "conversation":
      return `/c/${encodeURIComponent(page.id)}${page.message ? `?message=${encodeURIComponent(page.message)}` : ""}`;
    case "project":
      return `/p/${encodeURIComponent(page.id)}`;
    case "keys":
      return "/settings/keys";
  }
}

function ChatLink({ page, className, activeClassName, ...props }: ChatLinkProps) {
  const pathname = usePathname();
  const href = hrefOf(page);
  const active = pathname === href.split("?")[0];
  return <Link href={href} className={cn(className, active && activeClassName)} {...props} />;
}

function useChatLocation(): ChatLocation {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const conversationId = /^\/c\/([^/]+)$/.exec(pathname)?.[1];
  const openProject = /^\/p\/([^/]+)$/.exec(pathname)?.[1];
  return {
    conversationId: conversationId ? decodeURIComponent(conversationId) : undefined,
    newConversation: pathname === "/c",
    newConversationModel: searchParams.get("model") ?? undefined,
    projectId: openProject
      ? decodeURIComponent(openProject)
      : (searchParams.get("project") ?? undefined),
    pageTitle: pageTitles[pathname],
  };
}

/** The client root: the chat client and this app's routing for every page. */
export function ChatRoot({ children }: { children: ReactNode }) {
  const router = useRouter();
  const chatRouter = useMemo<ChatRouter>(
    () => ({
      Link: ChatLink,
      navigate: (page, options) =>
        options?.replace ? router.replace(hrefOf(page)) : router.push(hrefOf(page)),
      useLocation: useChatLocation,
      shareUrl: (token) => `${window.location.origin}/share/${token}`,
    }),
    [router],
  );
  return (
    <ChatProvider client={chatClient} router={chatRouter}>
      {children}
      <Toaster richColors />
    </ChatProvider>
  );
}
