import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

import { createI18n, type I18n, type Messages } from "../../shared/i18n";
import type { BotSdkClient } from "../chat-client";

export type { BotSdkOrpc } from "../chat-client";

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

/** The client without its transport (`orpc` and every URL), the Host's routing, and the dictionary. */
export type ChatAdapter = Omit<BotSdkClient, "rpc" | "fetch"> & ChatRouter & { i18n: I18n };

const ChatContext = createContext<ChatAdapter | null>(null);

/** Gives the chat UI its client, the host app's routing and its dictionary and locale. */
export function ChatProvider({
  client,
  router,
  queryClient,
  messages,
  locale = "en",
  children,
}: {
  client: BotSdkClient;
  router: ChatRouter;
  /** The Host's QueryClient, when it has one. Otherwise the provider makes its own. */
  queryClient?: QueryClient;
  /** The Host's text, by key. A key left out falls back to English. */
  messages?: Partial<Messages>;
  /** The locale dates, times and numbers are formatted in. */
  locale?: string;
  children: ReactNode;
}) {
  const [ownQueryClient] = useState(() => new QueryClient());
  const adapter = useMemo<ChatAdapter>(() => {
    const { rpc: _rpc, fetch: _fetch, ...urls } = client;
    return { ...router, ...urls, i18n: createI18n(messages, locale) };
  }, [client, router, messages, locale]);
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

/** The text for a key and the locale to format with, from the provider's dictionary. */
export function useI18n(): I18n {
  return useChatAdapter().i18n;
}

export function useChatLocation() {
  return useChatAdapter().useLocation();
}
