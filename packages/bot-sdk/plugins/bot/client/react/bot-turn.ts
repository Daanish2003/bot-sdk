import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { type BotSdkOrpc, useChatAdapter } from "../../../../core/client/react/provider";
import type { BotMessage } from "../../shared/turn";

/** A Message as the Conversation shows it: a saved one, or the user's Message still being sent. */
export type ShownBotMessage = BotMessage & { pending?: true };

/** A `send` in flight on this client: the user's Message until the server has saved it. */
type LocalTurn = { pending?: ShownBotMessage };

/** The sends in flight on one client, by Bot. They outlive any Conversation view. */
type LocalTurns = {
  snapshot: ReadonlyMap<string, LocalTurn>;
  listeners: Set<() => void>;
};

const noTurns: ReadonlyMap<string, LocalTurn> = new Map();
const stores = new WeakMap<QueryClient, LocalTurns>();

function storeOf(queryClient: QueryClient): LocalTurns {
  let store = stores.get(queryClient);
  if (!store) {
    store = { snapshot: noTurns, listeners: new Set() };
    stores.set(queryClient, store);
  }
  return store;
}

/** Replaces the Bot's send state (`undefined` ends it) and tells the views. */
function setLocalTurn(queryClient: QueryClient, botId: string, turn: LocalTurn | undefined) {
  const store = storeOf(queryClient);
  const next = new Map(store.snapshot);
  if (turn) next.set(botId, turn);
  else next.delete(botId);
  store.snapshot = next;
  store.listeners.forEach((listener) => listener());
}

function useLocalTurns() {
  const store = storeOf(useQueryClient());
  return useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => store.snapshot,
    () => noTurns,
  );
}

/**
 * Sends the user's Message and reads the Turn's stream. This runs against the query client, not in
 * a component, so a Turn goes on when the user opens another Bot or leaves the Bots app; only a
 * reload or closing the tab ends it.
 *
 * The user's Message shows at once, and the stream's first event (the saved Message) replaces it.
 * Each Message the Bot sends joins the cached Conversation as it arrives, and `turnEnded` sets the
 * cached Bot's Turn status, which "Seen ✓" reads.
 */
async function runSend(
  queryClient: QueryClient,
  orpc: BotSdkOrpc,
  botId: string,
  text: string,
): Promise<void> {
  type Conversation = Awaited<ReturnType<typeof orpc.bot.get.call>>;
  const getKey = orpc.bot.get.queryOptions({ input: { botId } }).queryKey;
  const update = (change: (data: Conversation) => Conversation) =>
    queryClient.setQueryData(getKey, (data) => data && change(data));
  const listKey = orpc.bot.list.queryKey();

  setLocalTurn(queryClient, botId, {
    pending: { id: "pending", role: "user", text, createdAt: new Date(), pending: true },
  });
  let ended = false;
  try {
    for await (const event of await orpc.bot.send.call({ botId, text })) {
      if (event.type === "message") {
        setLocalTurn(queryClient, botId, {});
        update((data) =>
          // A refetch during the Turn may already hold the Message.
          data.messages.some((shown) => shown.id === event.message.id)
            ? data
            : { ...data, messages: [...data.messages, event.message] },
        );
        if (event.message.role === "user")
          void queryClient.invalidateQueries({ queryKey: listKey });
      } else {
        ended = true;
        update((data) => ({ ...data, bot: { ...data.bot, turnStatus: event.status } }));
      }
    }
  } catch {
    // A refused or failed send leaves the server's state to show.
  } finally {
    // A stream that never ended leaves the cached Turn status stale, so ask the server.
    if (!ended) void queryClient.invalidateQueries({ queryKey: getKey });
    setLocalTurn(queryClient, botId, undefined);
    void queryClient.invalidateQueries({ queryKey: listKey });
  }
}

/** The Bots whose Turn a `send` on this client is running, so a sidebar row can say "Working…". */
export function useSendingBotIds(): ReadonlySet<string> {
  return new Set(useLocalTurns().keys());
}

/**
 * The client side of a Bot's Conversation: its Messages and its latest Turn's status, from the
 * server, plus the `send` this client has in flight. `working` is a Turn running anywhere: here, in
 * another tab, or before a reload. `seenMessageId` is the last Message when it is the user's and the
 * latest Turn ended `complete` (the Bot read it and stayed quiet); `failedMessageId` is that
 * Message when the Turn ended `error`.
 */
export function useBotTurn(botId: string) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const local = useLocalTurns().get(botId);
  const sending = local !== undefined;
  const query = useQuery({
    ...orpc.bot.get.queryOptions({ input: { botId } }),
    // A Turn running somewhere else shows its end only by asking again.
    refetchInterval: (state) =>
      !sending && state.state.data?.bot.turnStatus === "running" ? 2000 : false,
  });

  const messages: ShownBotMessage[] = [
    ...(query.data?.messages ?? []),
    ...(local?.pending ? [local.pending] : []),
  ];
  const last = messages.at(-1);
  const status = query.data?.bot.turnStatus;
  const working = sending || status === "running";
  const answered = !working && last?.role === "user" ? last.id : undefined;
  return {
    bot: query.data?.bot,
    error: query.error,
    messages,
    running: sending,
    working,
    seenMessageId: status === "complete" ? answered : undefined,
    failedMessageId: status === "error" ? answered : undefined,
    send: (text: string) => runSend(queryClient, orpc, botId, text),
  };
}
