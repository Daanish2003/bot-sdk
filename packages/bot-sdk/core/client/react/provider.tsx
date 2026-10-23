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
  | { to: "keys" }
  /** The Bots app; `id` opens that Bot's Conversation. */
  | { to: "bots"; id?: string };

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

/** The host app's routing, which the chat UI links and navigates through. */
export type ChatRouter = {
  Link: ComponentType<ChatLinkProps>;
  navigate: (page: ChatPage, options?: { replace?: boolean }) => Promise<void> | void;
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
    const { rpc: _rpc, fetch: _fetch, ...orpcAndUrls } = client;
    return { ...router, ...orpcAndUrls, i18n: createI18n(messages, locale) };
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
