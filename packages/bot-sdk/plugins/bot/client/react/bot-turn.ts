import type { SentFile } from "@botsdk/client/bot/files";
import type { BotMessage } from "@botsdk/client/bot/turn";
import { ORPCError } from "@orpc/client";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { type BotSdkOrpc, useChatAdapter } from "../../../../core/client/react/provider";
import { uuidv7 } from "../../../../core/shared/uuidv7";
import { inOrder, syncBot, useBotSync } from "./bot-sync";

/** A Message as the Conversation shows it: a saved one, or the user's Message still being sent. */
export type ShownBotMessage = BotMessage & { pending?: true };

/**
 * The `send`s in flight on one client for one Bot: how many requests are open, and the user's
 * Messages the server hasn't saved yet.
 */
type LocalTurn = { sends: number; pending: ShownBotMessage[] };

/**
 * The sends in flight on one client, by Bot. They outlive any Conversation view. `unsent` holds, by
 * Bot, the last send whose every attempt failed on the network, with its id: the server may have saved
 * it, so sending that text again reuses the id.
 */
type LocalTurns = {
  snapshot: ReadonlyMap<string, LocalTurn>;
  listeners: Set<() => void>;
  unsent: Map<string, { text: string; files: string; id: string }>;
};

const noTurns: ReadonlyMap<string, LocalTurn> = new Map();
const stores = new WeakMap<QueryClient, LocalTurns>();

function storeOf(queryClient: QueryClient): LocalTurns {
  let store = stores.get(queryClient);
  if (!store) {
    store = { snapshot: noTurns, listeners: new Set(), unsent: new Map() };
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

/** Tells the user's unsaved Messages apart until the server's saved one replaces them. */
let pendingSequence = 0;

/** How many times a send is made when its request fails on the network, before the server answers. */
const sendAttempts = 3;

/** The wait before retry `n` (from 1), longer each time. */
const retryDelayMs = (n: number) => 250 * n;

/** The browser's IANA time zone, sent with each Message so the Bot knows the user's "now". */
function browserTimeZone(): string | undefined {
  // An empty zone is left out: the server refuses one, and a Message without one reads as UTC.
  return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
}

/** Calls `bots.send`, again with the same input while the request fails on the network. */
async function sendWithRetry(
  orpc: BotSdkOrpc,
  input: { botId: string; id: string; text: string; files?: string[]; timeZone?: string },
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await orpc.bots.send.call(input);
    } catch (error) {
      // An answer from the server, a refusal included, is final; only a request that got none is retried.
      if (error instanceof ORPCError || attempt >= sendAttempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
  }
}

/**
 * Sends the user's Message and shows it. A send while a Turn runs is never refused: its Message
 * waits for the next Turn. This runs against the query client, not in a component, so a send goes
 * on when the user opens another Bot or leaves the Bots app.
 *
 * The user's Message shows at once, and the saved Message `bots.send` returns replaces it. The Turn
 * that takes it, and every Message the Bot sends, come through the change log (`syncBot`), which
 * runs once the Message is saved; until then the Bot reads as working.
 *
 * The send makes one uuidv7 for its Message and sends it as `id`. A request that fails on the network
 * before the server answers is made again with the same `id` (#498), after a short wait, so a Message
 * the server did save is never saved twice. When every attempt fails, the text goes back to the
 * composer as a refused one does, and sending the same text again reuses that `id`.
 *
 * A send the server refuses before saving the Message (402 Quota) removes the bubble and is handed
 * to `onRefused` with its text and files, so the composer can put them back. `files` are uploaded
 * ones (spec #801): the bubble shows them as the files card at once, and the text may be empty.
 */
async function runSend(
  queryClient: QueryClient,
  orpc: BotSdkOrpc,
  botId: string,
  text: string,
  files: SentFile[],
  onRefused?: (text: string, error: unknown, files: SentFile[]) => void,
): Promise<void> {
  const getKey = orpc.bots.get.queryOptions({ input: { botId } }).queryKey;
  const listKey = orpc.bots.list.queryKey();

  const unsent = storeOf(queryClient).unsent;
  const lost = unsent.get(botId);
  const fileIds = files.map((file) => file.id);
  const signature = fileIds.join(",");
  const id = lost?.text === text && lost.files === signature ? lost.id : uuidv7();
  unsent.delete(botId);
  const pending: ShownBotMessage = {
    id: `pending-${++pendingSequence}`,
    role: "user",
    text,
    createdAt: new Date(),
    pending: true,
    ...(files.length > 0 && { control: { kind: "files" as const, files } }),
  };
  changeLocalTurn(queryClient, botId, (turn) => ({
    sends: (turn?.sends ?? 0) + 1,
    pending: [...(turn?.pending ?? []), pending],
  }));
  const withoutPending = (turn: LocalTurn | undefined) =>
    turn && { ...turn, pending: turn.pending.filter((shown) => shown !== pending) };
  let saved = false;
  try {
    const sent = await sendWithRetry(orpc, {
      botId,
      id,
      text,
      ...(files.length > 0 && { files: fileIds }),
      timeZone: browserTimeZone(),
    });
    saved = true;
    // A `bots.get` that started before this write would answer after it with older Messages.
    if (queryClient.getQueryData(getKey)) await queryClient.cancelQueries({ queryKey: getKey });
    changeLocalTurn(queryClient, botId, withoutPending);
    queryClient.setQueryData(getKey, (data) =>
      // A sync during the send may already hold the Message.
      !data || data.messages.some((shown) => shown.id === sent.id)
        ? data
        : { ...data, messages: inOrder([...data.messages, sent]) },
    );
    void queryClient.invalidateQueries({ queryKey: listKey });
  } catch (error) {
    // An error after the save (a cache write) is no refusal. A send that got no answer may have been
    // saved, so its id is kept for the same text; a refused one goes back to the composer.
    if (!saved) {
      if (!(error instanceof ORPCError)) unsent.set(botId, { text, files: signature, id });
      onRefused?.(text, error, files);
    }
  } finally {
    // The Turn that takes the Message, and what it sends, are read from the change log; the Bot
    // reads as working until that has run.
    if (saved) await syncBot(queryClient, orpc, botId);
    changeLocalTurn(queryClient, botId, (turn) => {
      const rest = withoutPending(turn);
      return rest && rest.sends > 1 ? { ...rest, sends: rest.sends - 1 } : undefined;
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
 * Turn that took it ended `complete` (the Bot read it and stayed quiet), whatever a Routine or
 * Check-in ran since; `failedMessageId` is that Message when its Turn ended `error`. `onRefusedSend` gets the text of a send the server refused.
 */
export function useBotTurn(
  botId: string,
  {
    onRefusedSend,
  }: { onRefusedSend?: (text: string, error: unknown, files: SentFile[]) => void } = {},
) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const local = useLocalTurns().get(botId);
  const sending = local !== undefined;
  const query = useQuery(orpc.bots.get.queryOptions({ input: { botId } }));

  const messages: ShownBotMessage[] = [...(query.data?.messages ?? []), ...(local?.pending ?? [])];
  const last = messages.at(-1);
  const working = sending || query.data?.bot.turnStatus === "running";
  const status = query.data?.bot.userTurnStatus;
  // A Turn running anywhere, a Routine's or another tab's, shows through the change log.
  useBotSync(botId, query.data?.conversationId, working);
  const answered = !working && last?.role === "user" ? last.id : undefined;
  return {
    bot: query.data?.bot,
    error: query.error,
    messages,
    /** Each Turn's provenance: the Triggers it took, and whether it sent anything. */
    turns: query.data?.turns ?? [],
    /** The Bot's Summaries, oldest first (#676). */
    summaries: query.data?.summaries ?? [],
    /** The calls that warmed the Bot's cache, oldest first (#677). */
    warmings: query.data?.warmings ?? [],
    working,
    seenMessageId: status === "complete" ? answered : undefined,
    failedMessageId: status === "error" ? answered : undefined,
    send: (text: string, files: SentFile[] = []) =>
      runSend(queryClient, orpc, botId, text, files, onRefusedSend),
    /** Stops the Turn running anywhere; the views then read it as ended. */
    stop: async () => {
      try {
        await orpc.bots.stop.call({ botId });
      } finally {
        void syncBot(queryClient, orpc, botId);
        void queryClient.invalidateQueries({ queryKey: orpc.bots.list.queryKey() });
      }
    },
  };
}
