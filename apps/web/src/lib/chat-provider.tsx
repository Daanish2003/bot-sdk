import { type ChatLinkProps, type ChatPage, BotSdkProvider, type ChatRouter } from "@botsdk/react";
import type { QueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";

import { chatClient } from "@/utils/orpc";

/** The web app's route for each chat page. */
function routeOf(page: ChatPage) {
  switch (page.to) {
    case "keys":
      return { to: "/settings/keys" };
    case "rules":
      return { to: "/settings/rules" };
    case "bots":
      return page.id ? { to: "/bots/$botId", params: { botId: page.id } } : { to: "/bots" };
    case "rooms":
      return { to: "/bots/rooms/$conversationId", params: { conversationId: page.id } };
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
      Link: ChatLink,
      navigate: (page, options) => router.navigate({ ...routeOf(page), ...options }),
    }),
    [router],
  );
  return (
    <BotSdkProvider client={chatClient} router={chatRouter} queryClient={queryClient}>
      {children}
    </BotSdkProvider>
  );
}
