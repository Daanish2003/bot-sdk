import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useChatAdapter } from "../../../../core/client/react/provider";
import { useItemActions, useRefreshAfterTurns } from "./turn-list";

/** The `acting` key of Stop all. */
export const allHelpers = "all";

/**
 * A Bot's Helpers (#590), oldest first. They are asked for again when the change log says one
 * changed (`useBotSync`), and once a Turn ends, since it may have started one. `working` is that
 * Turn. `stop` stops one Helper, or all of them with no id (#591), and `done` is the user's Done on
 * a waiting one (#596); `acting` holds the Helpers (or `allHelpers`) with one in flight. A Helper's
 * hand-off Message is written by its job, not a Turn, so the Conversation is asked for again
 * whenever a Helper's status changes, and after each action, which may flip a Computer card.
 */
export function useBotHelpers(botId: string, working: boolean) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const options = orpc.helpers.list.queryOptions({ input: { botId } });
  const query = useQuery(options);
  const refreshHelpers = useRefreshAfterTurns(options.queryKey, working);
  const refreshConversation = () =>
    queryClient.invalidateQueries({ queryKey: orpc.bots.get.queryKey({ input: { botId } }) });
  const { acting, act } = useItemActions(async () => {
    await Promise.all([refreshHelpers(), refreshConversation()]);
  });

  const statuses = query.data?.map((helper) => `${helper.id}:${helper.status}`).join();
  // The first list loaded is no change.
  const seen = useRef(statuses);
  useEffect(() => {
    if (seen.current === statuses) return;
    const loaded = seen.current !== undefined;
    seen.current = statuses;
    if (loaded) void refreshConversation();
  });

  return {
    helpers: query.data ?? [],
    acting,
    stop: async (helperId?: string) => {
      await act(helperId ?? allHelpers, () => orpc.helpers.stop.call({ botId, helperId }));
    },
    done: async (helperId: string) => {
      await act(helperId, () => orpc.helpers.done.call({ helperId }));
    },
  };
}

/** Whether a live view only watches its Screen, or drives it. */
export type ScreenMode = "view" | "control";

/**
 * The live view of a waiting Helper's Screen (#597): a fresh link from `computer.view` on mount
 * (never stored), then Take control (`control`) when `startMode` asks for it. `switchTo` takes or
 * gives back control. Control taken here is given back when the view unmounts, even when it was
 * still being taken. `failed` once the link couldn't be had.
 */
export function useLiveView(helperId: string, startMode: ScreenMode = "view") {
  const { orpc } = useChatAdapter();
  const [url, setUrl] = useState<string>();
  const [mode, setMode] = useState<ScreenMode>("view");
  const [failed, setFailed] = useState(false);
  // Whether this view took control (or is taking it), so unmounting gives it back.
  const controlling = useRef(false);
  // Control calls go one after another, so a give-back can't overtake the take it undoes.
  const sent = useRef<Promise<unknown>>(Promise.resolve());
  const send = (next: ScreenMode) => {
    const call = sent.current
      .catch(() => {})
      .then(() => orpc.computer.control.call({ helperId, mode: next }));
    sent.current = call;
    return call;
  };
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const view = await orpc.computer.view.call({ helperId });
        if (startMode === "control") {
          controlling.current = true;
          await send("control");
        }
        if (!current) return;
        setUrl(view.url);
        setMode(startMode);
      } catch {
        if (current) setFailed(true);
      }
    })();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `send` only reads refs and these.
  }, [orpc, helperId, startMode]);
  useEffect(
    () => () => {
      if (!controlling.current) return;
      controlling.current = false;
      void send("view").catch(() => {});
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `send` only reads refs and these.
    [orpc, helperId],
  );
  return {
    url,
    mode,
    failed,
    switchTo: async (next: ScreenMode) => {
      controlling.current = next === "control";
      await send(next);
      setMode(next);
    },
  };
}

/** A fresh live-view link to a Helper's Screen (#597), absolute, for Copy link. */
export function useFreshLink(helperId: string) {
  const { orpc } = useChatAdapter();
  return async () => {
    const view = await orpc.computer.view.call({ helperId });
    return new URL(view.url, window.location.origin).href;
  };
}
