import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { type BotSdkOrpc, useChatAdapter } from "../../../../core/client/react/provider";
import type { BotChange } from "../../shared/changes";
import type { BotMessage } from "../../shared/turn";

/**
 * How often a tab with a running Turn fetches the change log when no signal has come (ADR 0026): a
 * recorded deviation from the lecture, since PubSub is at-most-once and a lost last hint would
 * leave "Working…" up.
 */
export const safetyFetchMs = 30_000;

/** Messages in the order they were saved. */
export const inOrder = (messages: BotMessage[]) =>
  messages.sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

type SyncState = { promise?: Promise<void>; again: boolean };
const states = new WeakMap<QueryClient, Map<string, SyncState>>();

function stateOf(queryClient: QueryClient, botId: string): SyncState {
  let bots = states.get(queryClient);
  if (!bots) states.set(queryClient, (bots = new Map()));
  let state = bots.get(botId);
  if (!state) bots.set(botId, (state = { again: false }));
  return state;
}

/**
 * Fetches Bot `botId`'s thread changes after the cursor (the cached `bots.get`'s `lastSeq`) and
 * applies them in seq order (ADR 0026). A cursor the log no longer holds, or a gap in the numbers,
 * reads the thread afresh with `bots.get`. One fetch runs at a time per Bot; a call made meanwhile
 * makes it fetch once more, so the result holds everything committed before that call. It never
 * rejects: a fetch that fails is tried again on the next signal.
 */
export function syncBot(queryClient: QueryClient, orpc: BotSdkOrpc, botId: string): Promise<void> {
  const state = stateOf(queryClient, botId);
  if (state.promise) {
    state.again = true;
    return state.promise;
  }
  const run = (async () => {
    try {
      do {
        state.again = false;
        await fetchOnce(queryClient, orpc, botId);
      } while (state.again);
    } finally {
      state.promise = undefined;
    }
  })();
  state.promise = run;
  return run;
}

async function fetchOnce(queryClient: QueryClient, orpc: BotSdkOrpc, botId: string) {
  const getKey = orpc.bots.get.queryOptions({ input: { botId } }).queryKey;
  const since = queryClient.getQueryData(getKey)?.lastSeq;
  // Nothing loaded yet: the first `bots.get` is the thread.
  if (since === undefined) return;
  let result;
  try {
    result = await orpc.bots.changes.call({ botId, since });
  } catch {
    return;
  }
  const lists = listKeys(orpc, botId);
  if (result.reload || !consecutive(since, result.changes)) {
    for (const queryKey of [getKey, orpc.bots.list.queryKey(), ...Object.values(lists)]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    return;
  }
  const { changes } = result;
  if (changes.length === 0) return;
  // A `bots.get` that started before these writes would answer after them with an older thread: it
  // is cancelled, and asked for again below.
  let rereadThread = queryClient.isFetching({ queryKey: getKey }) > 0;
  await queryClient.cancelQueries({ queryKey: getKey });
  for (const change of changes) {
    if (change.kind === "message") {
      const { data } = change;
      if (data) {
        queryClient.setQueryData(getKey, (thread) => {
          if (!thread) return thread;
          const others = thread.messages.filter((shown) => shown.id !== data.id);
          return { ...thread, messages: inOrder([...others, data]) };
        });
      }
    } else if (change.kind === "turn") {
      // A Turn starting or ending changes its provenance and what "Seen ✓" reads: read the thread.
      rereadThread = true;
      const { data } = change;
      if (data) {
        queryClient.setQueryData(
          getKey,
          (thread) => thread && { ...thread, bot: { ...thread.bot, turnStatus: data.status } },
        );
      }
    } else if (change.kind === "summary") {
      rereadThread = true;
    } else {
      void queryClient.invalidateQueries({ queryKey: lists[change.kind] });
    }
  }
  queryClient.setQueryData(
    getKey,
    (thread) => thread && { ...thread, lastSeq: Math.max(thread.lastSeq, changes.at(-1)!.seq) },
  );
  if (rereadThread) void queryClient.invalidateQueries({ queryKey: getKey });
  void queryClient.invalidateQueries({ queryKey: orpc.bots.list.queryKey() });
}

/** Whether `changes` run on from `since` with no number missing. */
function consecutive(since: number, changes: BotChange[]) {
  return changes.every((change, index) => change.seq === since + index + 1);
}

/** The queries that each other kind of change refreshes. */
function listKeys(orpc: BotSdkOrpc, botId: string) {
  const input = { input: { botId } };
  return {
    secret: orpc.secrets.list.queryKey(),
    routine: orpc.routines.list.queryKey(input),
    review: orpc.reviews.list.queryKey(input),
    helper: orpc.helpers.list.queryKey(input),
    check_in: orpc.checkIns.list.queryKey(input),
  };
}

/**
 * Keeps Bot `botId`'s thread in step with its change log (ADR 0026): a tab fetches the changes on
 * the data-less `changed` hint of the SSE `/events` route, when that stream (re)connects, when the
 * window gets focus back, and, while `working`, every `safetyFetchMs`. Renders nothing.
 */
export function useBotSync(botId: string, conversationId: string | undefined, working: boolean) {
  const { orpc, eventsUrl } = useChatAdapter();
  const queryClient = useQueryClient();

  useEffect(() => {
    const sync = () => void syncBot(queryClient, orpc, botId);
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVisible);
    let source: EventSource | undefined;
    if (conversationId && typeof EventSource !== "undefined") {
      source = new EventSource(`${eventsUrl}?conversationId=${conversationId}`);
      // Opens on the first connect and on each reconnect: what was missed meanwhile is fetched.
      source.onopen = sync;
      source.onmessage = (event: MessageEvent<string>) => {
        let hint: { type?: string };
        try {
          hint = JSON.parse(event.data);
        } catch {
          return;
        }
        if (hint.type === "changed") sync();
      };
    }
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", onVisible);
      source?.close();
    };
  }, [botId, conversationId, eventsUrl, orpc, queryClient]);

  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void syncBot(queryClient, orpc, botId), safetyFetchMs);
    return () => clearInterval(timer);
  }, [botId, working, orpc, queryClient]);
}
