import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

/**
 * The refresh of a Bot's list that its Turns change (its Routines, its Check-ins). `working` is a
 * Turn running anywhere (`useBotTurn`): the list is asked for again once it ends, since it may have
 * changed the list.
 */
export function useRefreshAfterTurns(queryKey: QueryKey, working: boolean) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) void refresh();
    wasWorking.current = working;
  });
  return refresh;
}

/**
 * The user's actions on a list's items, one at a time per item: `acting` holds the items with one
 * in flight, so every control for an item (a divider's and a popover row's) waits on the same one.
 * `act` runs `call` for item `id`, then asks for the list again; while one runs, another does
 * nothing and gives `undefined`.
 */
export function useItemActions(refresh: () => Promise<void>) {
  const running = useRef(new Set<string>());
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const act = async <R>(id: string, call: () => Promise<R>): Promise<R | undefined> => {
    if (running.current.has(id)) return undefined;
    running.current.add(id);
    setActing(new Set(running.current));
    try {
      return await call();
    } finally {
      await refresh();
      running.current.delete(id);
      setActing(new Set(running.current));
    }
  };
  return { acting, act };
}
