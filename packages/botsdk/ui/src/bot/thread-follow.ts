import { useLayoutEffect, useRef } from "react";

/** How far from the end, in pixels, still counts as reading the end of the thread. */
const nearEndPx = 150;

/**
 * Keeps a thread's scroller on its newest Message. It opens at the end and follows what arrives
 * while the reader is near the end. A reader who scrolled up stays put, until they send
 * (`ownMessageId` changes) or open another thread (`threadId` changes). Spread the result on the
 * scroller.
 */
export function useThreadFollow(threadId: string, ownMessageId: string | undefined) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const seen = useRef({ threadId, ownMessageId });

  // On every render: anything in a thread can grow it, not only a new Message.
  useLayoutEffect(() => {
    if (seen.current.threadId !== threadId || seen.current.ownMessageId !== ownMessageId) {
      seen.current = { threadId, ownMessageId };
      following.current = true;
    }
    const element = scroller.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  });

  return {
    ref: scroller,
    onScroll: () => {
      const element = scroller.current;
      if (!element) return;
      const fromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
      following.current = fromEnd <= nearEndPx;
    },
  };
}
