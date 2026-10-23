import {
  type ChatLinkProps,
  type ChatLocation,
  type ChatPage,
  ChatProvider,
  type ChatRouter,
} from "@ai-chat/bot-sdk/core/client";
import type { QueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";

import { chatClient } from "@/utils/orpc";

/** The web app's route for each chat page. The assistant's pages went with it (#819). */
function routeOf(page: ChatPage) {
  switch (page.to) {
    case "keys":
      return { to: "/settings/keys" };
    case "bots":
      return page.id ? { to: "/bots/$botId", params: { botId: page.id } } : { to: "/bots" };
    default:
      throw new Error(`The web app has no "${page.to}" page`);
  }
}

function ChatLink({ page, activeClassName, ...props }: ChatLinkProps) {
  return (
    <Link
      {...routeOf(page)}
      {...props}
      activeProps={activeClassName ? { className: activeClassName } : undefined}
    />
  );
}

const pageTitles: Record<string, string> = {
  "/settings/keys": "Keys & settings",
  "/settings/account": "Account",
};

function useChatLocation(): ChatLocation {
  const pathname = useLocation({ select: (location) => location.pathname.replace(/\/$/, "") });
  return { newConversation: false, pageTitle: pageTitles[pathname] };
}

/** The chat UI wired to this app's chat client and TanStack Router routes. */
export function WebChatProvider({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient: QueryClient;
}) {
  const router = useRouter();
  const chatRouter = useMemo<ChatRouter>(
    () => ({
      shareUrl: (token) => `${window.location.origin}/share/${token}`,
      Link: ChatLink,
      navigate: (page, options) => router.navigate({ ...routeOf(page), ...options }),
      useLocation: useChatLocation,
    }),
    [router],
  );
  return (
    <ChatProvider client={chatClient} router={chatRouter} queryClient={queryClient}>
      {children}
    </ChatProvider>
  );
}
