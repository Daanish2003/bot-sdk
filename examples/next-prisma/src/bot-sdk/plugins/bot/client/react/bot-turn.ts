import { ORPCError } from "@orpc/client";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { type BotSdkOrpc, useChatAdapter } from "../../../../core/client/react/provider";
import { uuidv7 } from "../../../../core/shared/uuidv7";
import type { BotMessage } from "../../shared/turn";

/** A Message as the Conversation shows it: a saved one, or the user's Message still being sent. */
export type ShownBotMessage = BotMessage & { pending?: true };

/**
 * The `send`s in flight on one client for one Bot: how many streams are open, and the user's
 * Messages the server hasn't saved yet.
 */
type LocalTurn = { streams: number; pending: ShownBotMessage[] };

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

/** Changes the Bot's send state (`undefined` ends it) and tells the views. */
function changeLocalTurn(
  queryClient: QueryClient,
  botId: string,
  change: (turn: LocalTurn | undefined) => LocalTurn | undefined,
) {
  const store = storeOf(queryClient);
  const turn = change(store.snapshot.get(botId));
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

/** Messages in the order they were saved: several streams may each yield some, out of order. */
const inOrder = (messages: BotMessage[]) =>
  messages.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

/** Tells the user's unsaved Messages apart until the server's saved one replaces them. */
let pendingSequence = 0;

/** How many times a send is made when its request fails on the network, before the server answers. */
const sendAttempts = 3;

/** Calls `bot.send`, again with the same input while the request fails on the network. */
async function sendWithRetry(orpc: BotSdkOrpc, input: { botId: string; id: string; text: string }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await orpc.bot.send.call(input);
    } catch (error) {
      // An answer from the server, a refusal included, is final; only a request that got none is retried.
      if (error instanceof ORPCError || attempt >= sendAttempts) throw error;
    }
  }
}

/**
 * Sends the user's Message and reads the stream of the Turn that takes it. A send while a Turn
 * runs is never refused: its Message waits for the next Turn, and its stream follows that one. This runs against the query client, not in
 * a component, so a Turn goes on when the user opens another Bot or leaves the Bots app; only a
 * reload or closing the tab ends it.
 *
 * The user's Message shows at once, and the stream's first event (the saved Message) replaces it.
 * Each Message the Bot sends joins the cached Conversation as it arrives, and `turnEnded` sets the
 * cached Bot's Turn status, which "Seen ✓" reads.
 *
 * The send makes one uuidv7 for its Message and sends it as `id`. A request that fails on the network
 * before the server answers is made again with the same `id` (#498), so a Message the server did
 * save is never saved twice and the repeat re-joins its Turn.
 *
 * A send the server refuses before saving the Message (402 Quota) removes the bubble and is handed
 * to `onRefused` with its text, so the composer can put it back.
 */
async function runSend(
  queryClient: QueryClient,
  orpc: BotSdkOrpc,
  botId: string,
  text: string,
  onRefused?: (text: string, error: unknown) => void,
): Promise<void> {
  type Conversation = Awaited<ReturnType<typeof orpc.bot.get.call>>;
  const getKey = orpc.bot.get.queryOptions({ input: { botId } }).queryKey;
  const update = (change: (data: Conversation) => Conversation) =>
    queryClient.setQueryData(getKey, (data) => data && change(data));
  // A `bot.get` that started before a write would answer after it with older Messages, so it is
  // cancelled first. The first load isn't: with no data there is nothing to write over.
  const cancelRefetch = async () => {
    if (queryClient.getQueryData(getKey)) await queryClient.cancelQueries({ queryKey: getKey });
  };
  const listKey = orpc.bot.list.queryKey();

  const id = uuidv7();
  const pending: ShownBotMessage = {
    id: `pending-${++pendingSequence}`,
    role: "user",
    text,
    createdAt: new Date(),
    pending: true,
  };
  changeLocalTurn(queryClient, botId, (turn) => ({
    streams: (turn?.streams ?? 0) + 1,
    pending: [...(turn?.pending ?? []), pending],
  }));
  const withoutPending = (turn: LocalTurn | undefined) =>
    turn && { ...turn, pending: turn.pending.filter((shown) => shown !== pending) };
  let ended = false;
  // The stream's first event is the saved user Message: an error before it is a refusal.
  let saved = false;
  try {
    for await (const event of await sendWithRetry(orpc, { botId, id, text })) {
      await cancelRefetch();
      if (event.type === "message") {
        saved = true;
        changeLocalTurn(queryClient, botId, withoutPending);
        update((data) =>
          // A refetch during the Turn may already hold the Message.
          data.messages.some((shown) => shown.id === event.message.id)
            ? data
            : { ...data, messages: inOrder([...data.messages, event.message]) },
        );
        if (event.message.role === "user")
          void queryClient.invalidateQueries({ queryKey: listKey });
      } else {
        ended = true;
        update((data) => ({ ...data, bot: { ...data.bot, turnStatus: event.status } }));
      }
    }
  } catch (error) {
    // A failed send leaves the server's state to show; a refused one goes back to the composer.
    if (!saved) onRefused?.(text, error);
  } finally {
    // A stream that never ended leaves the cached Turn status stale, so ask the server.
    if (!ended) void queryClient.invalidateQueries({ queryKey: getKey });
    changeLocalTurn(queryClient, botId, (turn) => {
      const rest = withoutPending(turn);
      return rest && rest.streams > 1 ? { ...rest, streams: rest.streams - 1 } : undefined;
    });
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
 * Message when the Turn ended `error`. `onRefusedSend` gets the text of a send the server refused.
 */
export function useBotTurn(
  botId: string,
  { onRefusedSend }: { onRefusedSend?: (text: string, error: unknown) => void } = {},
) {
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

  const messages: ShownBotMessage[] = [...(query.data?.messages ?? []), ...(local?.pending ?? [])];
  const last = messages.at(-1);
  const status = query.data?.bot.turnStatus;
  const working = sending || status === "running";
  const answered = !working && last?.role === "user" ? last.id : undefined;
  return {
    bot: query.data?.bot,
    error: query.error,
    messages,
    working,
    seenMessageId: status === "complete" ? answered : undefined,
    failedMessageId: status === "error" ? answered : undefined,
    send: (text: string) => runSend(queryClient, orpc, botId, text, onRefusedSend),
    /** Stops the Turn running anywhere; the views then read it as ended. */
    stop: async () => {
      try {
        await orpc.bot.stop.call({ botId });
      } finally {
        void queryClient.invalidateQueries({
          queryKey: orpc.bot.get.queryOptions({ input: { botId } }).queryKey,
        });
        void queryClient.invalidateQueries({ queryKey: orpc.bot.list.queryKey() });
      }
    },
  };
}
