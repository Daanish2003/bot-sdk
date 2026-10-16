import { useEffect, useEffectEvent, useRef, useState } from "react";

import { focusStep } from "../../core/client/search";

/** How long an opened search hit stays highlighted. */
const highlightMs = 2_500;
const scrollDelayMs = 100;

/**
 * Lands on the search hit `target`: switches to the Branch through it when the Active Branch
 * doesn't have it (the newest leaf below it), then scrolls to it and highlights it for ~2.5 s.
 * Calls `onFocused` once it's done or the switch failed. Returns the highlighted Message's id.
 */
export function useFocusMessage({
  target,
  onScreen,
  activeBranch,
  switchBranch,
  onFocused,
}: {
  target: string | undefined;
  /** Ids of the Messages rendered. */
  onScreen: string[];
  /** Ids of the server's Active Branch. */
  activeBranch: string[];
  /** Resolves once the new Active Branch has been fetched; rejects when the switch failed. */
  switchBranch: (messageId: string) => Promise<unknown>;
  onFocused: () => void;
}) {
  const [highlighted, setHighlighted] = useState<string>();
  const switched = useRef<string>(undefined);
  const step = target ? focusStep(target, onScreen, activeBranch) : undefined;

  const advance = useEffectEvent((id: string) => {
    if (step === "highlight") {
      // After the chat container's own first scroll to the bottom (a resize observer), which
      // would otherwise undo this one on a freshly opened Conversation.
      setTimeout(
        () =>
          document
            .querySelector(`[data-message-id="${CSS.escape(id)}"]`)
            ?.scrollIntoView({ block: "center" }),
        scrollDelayMs,
      );
      setHighlighted(id);
      switched.current = undefined;
      onFocused();
    } else if (step === "switch" && switched.current !== id) {
      switched.current = id;
      switchBranch(id).catch(() => {
        switched.current = undefined;
        onFocused();
      });
    }
  });
  useEffect(() => {
    if (target) advance(target);
  }, [target, step]);

  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(undefined), highlightMs);
    return () => clearTimeout(timer);
  }, [highlighted]);

  return highlighted;
}
