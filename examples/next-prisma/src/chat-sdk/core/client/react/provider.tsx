import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

import type { ChatClient } from "../chat-client";

export type { ChatOrpc } from "../chat-client";

/** A page the chat UI links or navigates to. The host app maps each to its own route. */
export type ChatPage =
  /** `projectId` starts the new Conversation inside that Project. */
  | { to: "new"; model?: string; projectId?: string }
  | { to: "conversation"; id: string; message?: string }
  | { to: "project"; id: string }
  | { to: "keys" };

export type ChatLinkProps = {
  page: ChatPage;
  className?: string;
  /** Added to `className` while `page` is the current page. */
  activeClassName?: string;
  title?: string;
  "aria-label"?: string;
  onClick?: () => void;
  children?: ReactNode;
};

/** Where the user is, as far as the chat UI cares. */
export type ChatLocation = {
  /** The Conversation open on its page. */
  conversationId?: string;
  /** On the new Conversation page. */
  newConversation: boolean;
  /** The Model picked for the new Conversation (`?model=` in the web app). */
  newConversationModel?: string;
  /** The Project open on its page, or the one a new Conversation is started in (`?project=`). */
  projectId?: string;
  /** The top bar's title on a page that isn't a Conversation. */
  pageTitle?: string;
};

/** The host app's routing, which the chat UI links and navigates through. */
export type ChatRouter = {
  Link: ComponentType<ChatLinkProps>;
  navigate: (page: ChatPage, options?: { replace?: boolean }) => Promise<void> | void;
  /** A hook: called during render by the chat UI. */
  useLocation: () => ChatLocation;
  /** A Shared link's public URL. */
  shareUrl: (token: string) => string;
};

export type ChatAdapter = Pick<ChatClient, "orpc" | "chatUrl" | "exportUrl" | "connectionsUrl"> &
  ChatRouter;

const ChatContext = createContext<ChatAdapter | null>(null);

/** Gives the chat UI its client and the host app's routing. */
export function ChatProvider({
  client,
  router,
  queryClient,
  children,
}: {
  client: ChatClient;
  router: ChatRouter;
  /** The Host's QueryClient, when it has one. Otherwise the provider makes its own. */
  queryClient?: QueryClient;
  children: ReactNode;
}) {
  const [ownQueryClient] = useState(() => new QueryClient());
  const adapter = useMemo<ChatAdapter>(
    () => ({
      ...router,
      orpc: client.orpc,
      chatUrl: client.chatUrl,
      exportUrl: client.exportUrl,
      connectionsUrl: client.connectionsUrl,
    }),
    [client, router],
  );
  return (
    <QueryClientProvider client={queryClient ?? ownQueryClient}>
      <ChatContext value={adapter}>{children}</ChatContext>
    </QueryClientProvider>
  );
}

export function useChatAdapter() {
  const adapter = useContext(ChatContext);
  if (!adapter) throw new Error("The chat UI must be inside a <ChatProvider>");
  return adapter;
}

export function useOrpc() {
  return useChatAdapter().orpc;
}

export function useChatLocation() {
  return useChatAdapter().useLocation();
}
