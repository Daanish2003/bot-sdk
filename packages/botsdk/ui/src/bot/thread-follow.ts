import { useLayoutEffect, useRef } from "react";

/** How far from the end, in pixels, still counts as reading the end of the thread. */
const nearEndPx = 150;

/**
 * Keeps a thread's scroller on its newest Message. It opens at the end and follows what arrives
 * while the reader is near the end. A reader who scrolled up stays put, until they send
 * (`ownMessageId` changes) or open another thread (`threadId` changes). It also follows content
 * that grows by itself, such as highlighting finishing, which renders nothing in the thread; a
 * reader scrolled up isn't moved by that, nor by expanding a block. Spread the result on the
 * scroller.
 */
export function useThreadFollow(threadId: string, ownMessageId: string | undefined) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // Where the scroller was last seen. Growth moves the end away without the reader scrolling, so a
  // scroll event that goes forward never ends the following; only one that goes back does.
  const lastTop = useRef(0);
  const toEnd = (element: HTMLDivElement) => {
    element.scrollTop = element.scrollHeight;
    lastTop.current = element.scrollTop;
  };
  const seen = useRef({ threadId, ownMessageId });

  // On every render: anything in a thread can grow it, not only a new Message.
  useLayoutEffect(() => {
    if (seen.current.threadId !== threadId || seen.current.ownMessageId !== ownMessageId) {
      seen.current = { threadId, ownMessageId };
      following.current = true;
    }
    const element = scroller.current;
    if (element && following.current) toEnd(element);
  });

  // Growth that renders nothing here: watch the children's size, and re-watch when they change.
  // The scroller may mount after the hook's first render, so each render checks for a new one.
  const watched = useRef<{ element: HTMLDivElement; stop: () => void }>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (watched.current?.element === element) return;
    watched.current?.stop();
    watched.current = null;
    if (!element || typeof ResizeObserver === "undefined") return;
    const follow = () => {
      if (following.current) toEnd(element);
    };
    const sizes = new ResizeObserver(follow);
    const watch = () => {
      sizes.disconnect();
      for (const child of element.children) sizes.observe(child, { box: "border-box" });
    };
    watch();
    const children = new MutationObserver(watch);
    children.observe(element, { childList: true });
    watched.current = {
      element,
      stop: () => {
        sizes.disconnect();
        children.disconnect();
      },
    };
  });
  useLayoutEffect(
    () => () => {
      watched.current?.stop();
      watched.current = null;
    },
    [],
  );

  return {
    ref: scroller,
    onScroll: () => {
      const element = scroller.current;
      if (!element) return;
      const wentBack = element.scrollTop < lastTop.current;
      lastTop.current = element.scrollTop;
      const fromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
      if (wentBack || !following.current) following.current = fromEnd <= nearEndPx;
    },
  };
}
