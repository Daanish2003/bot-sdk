import type { BotChange } from "@botsdk/client/bot/changes";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { type BotSdkOrpc, useChatAdapter } from "../provider";
import { inOrder, safetyFetchMs } from "./bot-sync";

/*
 * A Room (spec #1055): the thread the user shares with several of their Bots, read with
 * `rooms.get` and followed through the Conversation's change log, as a Bot's thread is (ADR 0026).
 */

const running = new WeakMap<
  QueryClient,
  Map<string, { promise?: Promise<void>; again: boolean }>
>();

/**
 * Fetches Room `conversationId`'s changes after the cached `rooms.get`'s `lastSeq` and applies its
 * Messages; a member's Bot changing (paused or resumed) reads the Room afresh. A cursor the log no longer holds, or a gap in the numbers, reads the Room afresh. One
 * fetch runs at a time per Room; a call made meanwhile makes it fetch once more. It never rejects.
 */
export function syncRoom(
  queryClient: QueryClient,
  orpc: BotSdkOrpc,
  conversationId: string,
): Promise<void> {
  let rooms = running.get(queryClient);
  if (!rooms) running.set(queryClient, (rooms = new Map()));
  let state = rooms.get(conversationId);
  if (!state) rooms.set(conversationId, (state = { again: false }));
  const current = state;
  if (current.promise) {
    current.again = true;
    return current.promise;
  }
  current.promise = (async () => {
    try {
      do {
        current.again = false;
        await fetchOnce(queryClient, orpc, conversationId);
      } while (current.again);
    } finally {
      current.promise = undefined;
    }
  })();
  return current.promise;
}

async function fetchOnce(queryClient: QueryClient, orpc: BotSdkOrpc, conversationId: string) {
  const getKey = orpc.rooms.get.queryKey({ input: { conversationId } });
  const loaded = queryClient.getQueryData(getKey);
  if (!loaded) return;
  const since = loaded.lastSeq;
  let result;
  try {
    result = await orpc.conversations.changes.call({ conversationId, since });
  } catch {
    return;
  }
  if (result.reload || !consecutive(since, result.changes)) {
    void queryClient.invalidateQueries({ queryKey: getKey });
    void queryClient.invalidateQueries({ queryKey: orpc.rooms.list.queryKey() });
    return;
  }
  const { changes } = result;
  if (changes.length === 0) return;
  // A `rooms.get` that started before these writes would answer with an older thread.
  let reread = queryClient.isFetching({ queryKey: getKey }) > 0;
  await queryClient.cancelQueries({ queryKey: getKey });
  queryClient.setQueryData(getKey, (thread) => {
    if (!thread) return thread;
    let messages = thread.messages;
    for (const change of changes) {
      if (change.kind === "bot") reread = true;
      if (change.kind !== "message" || !change.data) continue;
      const data = change.data;
      messages = [...messages.filter((shown) => shown.id !== data.id), data];
    }
    // A `rooms.get` that answered meanwhile may hold a newer cursor.
    const lastSeq = Math.max(thread.lastSeq, changes.at(-1)!.seq);
    return { ...thread, messages: inOrder(messages), lastSeq };
  });
  if (reread) void queryClient.invalidateQueries({ queryKey: getKey });
  void queryClient.invalidateQueries({ queryKey: orpc.rooms.list.queryKey() });
}

/** Whether `changes` run on from `since` with no number missing. */
function consecutive(since: number, changes: BotChange[]) {
  return changes.every((change, index) => change.seq === since + index + 1);
}

/** The user's Rooms, the newest activity first. */
export function useRooms() {
  const { orpc } = useChatAdapter();
  return useQuery(orpc.rooms.list.queryOptions());
}

/**
 * Room `conversationId`: its members and Messages, kept in step with its change log on the SSE
 * `changed` hint, when that stream (re)connects, when the window gets focus back and, while the
 * user's newest Message waits for a reply, every `safetyFetchMs` (ADR 0026: a hint can be lost);
 * and `send`, which sends the user's Message to it.
 */
export function useRoom(conversationId: string) {
  const { orpc, eventsUrl } = useChatAdapter();
  const queryClient = useQueryClient();
  const thread = useQuery(orpc.rooms.get.queryOptions({ input: { conversationId } }));

  useEffect(() => {
    const sync = () => void syncRoom(queryClient, orpc, conversationId);
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVisible);
    let source: EventSource | undefined;
    if (typeof EventSource !== "undefined") {
      source = new EventSource(`${eventsUrl}?conversationId=${conversationId}`);
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
  }, [conversationId, eventsUrl, orpc, queryClient]);

  // The Room has no Turn status of its own: a reply is awaited while the newest Message is the user's.
  const waiting = thread.data?.messages.at(-1)?.role === "user";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(
      () => void syncRoom(queryClient, orpc, conversationId),
      safetyFetchMs,
    );
    return () => clearInterval(timer);
  }, [conversationId, waiting, orpc, queryClient]);

  const sending = useMutation(
    orpc.rooms.send.mutationOptions({
      onSuccess: (sent) => {
        queryClient.setQueryData(
          orpc.rooms.get.queryKey({ input: { conversationId } }),
          (loaded) =>
            loaded && {
              ...loaded,
              messages: inOrder([...loaded.messages.filter((shown) => shown.id !== sent.id), sent]),
            },
        );
        void queryClient.invalidateQueries({ queryKey: orpc.rooms.list.queryKey() });
      },
    }),
  );

  return {
    room: thread.data?.room,
    messages: thread.data?.messages ?? [],
    error: thread.error,
    send: (text: string) => sending.mutateAsync({ conversationId, text }),
    sending: sending.isPending,
  };
}
