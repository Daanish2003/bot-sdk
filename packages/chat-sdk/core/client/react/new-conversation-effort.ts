import { useSyncExternalStore } from "react";

import type { ReasoningChoice } from "../../shared/chat/models";

/**
 * The reasoning effort a new Conversation will be created with, picked beside the top bar's Model
 * picker and read by the new Conversation page. `null` is the Model's default. It lives outside the
 * router location, so the Host's routes don't need to know about it.
 */
let chosen: ReasoningChoice | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setNewConversationEffort(effort: ReasoningChoice | null) {
  chosen = effort;
  for (const listener of listeners) listener();
}

export function useNewConversationEffort() {
  const effort = useSyncExternalStore(
    subscribe,
    () => chosen,
    () => null,
  );
  return { effort, setEffort: setNewConversationEffort };
}
