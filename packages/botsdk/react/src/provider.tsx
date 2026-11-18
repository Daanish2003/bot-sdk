import type { BotSdkClient, BotSdkOrpc, CoreContract } from "@botsdk/client";
import type { AnyContractRouter } from "@orpc/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

import { createI18n, type I18n, type Messages } from "@botsdk/client/i18n";

export type { BotSdkOrpc } from "@botsdk/client";

/** A page the chat UI links or navigates to. The host app maps each to its own route. */
export type ChatPage =
  | { to: "keys" }
  /** The rules page, where the user manages the rules for all their Bots. */
  | { to: "rules" }
  /** The Bots app; `id` opens that Bot's Conversation. */
  | { to: "bots"; id?: string }
  /** A Room (spec #1055): the Conversation `id` the user shares with several of their Bots. */
  | { to: "rooms"; id: string };

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
export function BotSdkProvider({
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

/**
 * The provider's adapter. A feature's UI names the URLs its client part adds:
 * `useChatAdapter<McpUrls>()`.
 */
export function useChatAdapter<Urls extends object = object>(): ChatAdapter & Urls {
  const adapter = useContext(ChatContext);
  if (!adapter) throw new Error("The chat UI must be inside a <BotSdkProvider>");
  return adapter as ChatAdapter & Urls;
}

/**
 * TanStack Query helpers over the core's procedures. A feature's UI names its contract under its
 * id, which the Host enabled with its client part: `useOrpc<{ memory: MemoryContract }>()`.
 */
export function useOrpc<
  Features extends Record<string, AnyContractRouter> = Record<never, never>,
>(): BotSdkOrpc<CoreContract & Features> {
  return useChatAdapter().orpc as unknown as BotSdkOrpc<CoreContract & Features>;
}

/**
 * A procedure's mutation options, as its TanStack Query helper takes them: a feature's mutation
 * hook takes them and passes them on (`useMutation(memory.botAddLine.mutationOptions(options))`).
 */
export type ProcedureMutationOptions<
  Procedure extends { mutationOptions: (...args: never[]) => unknown },
> = Parameters<Procedure["mutationOptions"]>[0];

/** The text for a key and the locale to format with, from the provider's dictionary. */
export function useI18n(): I18n {
  return useChatAdapter().i18n;
}
