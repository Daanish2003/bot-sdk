// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useThreadFollow } from "../../src/bot/thread-follow";

/** A ResizeObserver jsdom lacks: `resize()` reports the observed elements as resized. */
const observed = new Set<Element>();
const callbacks = new Set<() => void>();
class FakeResizeObserver {
  callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe(target: Element) {
    callbacks.add(this.callback);
    observed.add(target);
  }
  unobserve(target: Element) {
    observed.delete(target);
  }
  disconnect() {
    callbacks.delete(this.callback);
  }
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);
const resize = () => callbacks.forEach((callback) => callback());

afterEach(() => {
  cleanup();
  observed.clear();
  callbacks.clear();
});

type Props = { threadId: string; ownMessageId?: string; revision: number };

function Thread({ threadId, ownMessageId }: Props) {
  const follow = useThreadFollow(threadId, ownMessageId);
  return createElement(
    "div",
    { "data-testid": "thread", ...follow },
    createElement(
      "div",
      { "data-testid": "child" },
      createElement("button", { "aria-expanded": false }, "Show all lines"),
      createElement("button", null, "Copy"),
    ),
  );
}

/** A frame, for the end of what a click on an expanding control counts as asked for. */
const nextFrames = () =>
  new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

/** Renders a thread whose content is `height` tall in a 100px box; jsdom lays nothing out. */
function setup(height: number) {
  let props: Props = { threadId: "a", revision: 0 };
  const view = render(createElement(Thread, props));
  const element = view.getByTestId("thread");
  let content = height;
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => 100 });
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => content });
  const update = (change: Partial<Props>, grownTo = content) => {
    content = grownTo;
    props = { ...props, ...change, revision: props.revision + 1 };
    view.rerender(createElement(Thread, props));
  };
  const scrollTo = (top: number) => {
    element.scrollTop = top;
    fireEvent.scroll(element);
  };
  /** Content grows with no render of the thread, as when highlighting finishes. */
  const grow = (grownTo: number) => {
    content = grownTo;
    resize();
  };
  return { element, update, scrollTo, grow };
}

describe("useThreadFollow, when the reader expands something", () => {
  const button = (element: HTMLElement, name: string) =>
    [...element.querySelectorAll("button")].find((each) => each.textContent === name)!;

  it("doesn't move a reader near the end, then or when the thread next renders", () => {
    const { element, update, scrollTo, grow } = setup(1000);
    update({});
    scrollTo(880);
    fireEvent.click(button(element, "Show all lines"));
    grow(2000);
    expect(element.scrollTop).toBe(880);
    update({});
    expect(element.scrollTop).toBe(880);
  });

  it("keeps following when what opened still leaves the reader near the end", async () => {
    const { element, update, grow } = setup(1000);
    update({});
    fireEvent.click(button(element, "Show all lines"));
    grow(1050);
    expect(element.scrollTop).toBe(1000);
    await nextFrames();
    update({}, 1500);
    expect(element.scrollTop).toBe(1500);
  });

  it("follows again once what they opened is closed, leaving them at the end", async () => {
    const { element, update, grow } = setup(1000);
    update({});
    fireEvent.click(button(element, "Show all lines"));
    grow(1400);
    await nextFrames();
    fireEvent.click(button(element, "Show all lines"));
    grow(1000);
    await nextFrames();
    update({}, 1500);
    expect(element.scrollTop).toBe(1500);
  });

  it("follows growth that comes by itself after the expanding is over", async () => {
    const { element, update, grow } = setup(1000);
    update({});
    fireEvent.click(button(element, "Show all lines"));
    await nextFrames();
    grow(1500);
    expect(element.scrollTop).toBe(1500);
  });

  it("still follows growth after a click on anything else", () => {
    const { element, update, grow } = setup(1000);
    update({});
    fireEvent.click(button(element, "Copy"));
    grow(1500);
    expect(element.scrollTop).toBe(1500);
  });
});

describe("useThreadFollow", () => {
  it("opens at the newest Message", () => {
    const { element, update } = setup(1000);
    update({});
    expect(element.scrollTop).toBe(1000);
  });

  it("follows what arrives while the reader is at the end", () => {
    const { element, update } = setup(1000);
    update({});
    update({}, 1500);
    expect(element.scrollTop).toBe(1500);
  });

  it("follows from just short of the end", () => {
    const { element, update, scrollTo } = setup(1000);
    update({});
    scrollTo(880);
    update({}, 1500);
    expect(element.scrollTop).toBe(1500);
  });

  it("leaves a reader who scrolled up where they are", () => {
    const { element, update, scrollTo } = setup(1000);
    update({});
    scrollTo(200);
    update({}, 1500);
    expect(element.scrollTop).toBe(200);
  });

  it("goes to the end when the reader sends, even scrolled up, and follows again", () => {
    const { element, update, scrollTo } = setup(1000);
    update({});
    scrollTo(200);
    update({ ownMessageId: "m1" }, 1100);
    expect(element.scrollTop).toBe(1100);
    update({}, 1400);
    expect(element.scrollTop).toBe(1400);
  });

  it("opens another thread at its newest Message", () => {
    const { element, update, scrollTo } = setup(1000);
    update({});
    scrollTo(200);
    update({ threadId: "b" }, 2000);
    expect(element.scrollTop).toBe(2000);
  });

  it("follows content that grows by itself while the reader is near the end", () => {
    const { element, update, grow } = setup(1000);
    update({});
    grow(1300);
    expect(element.scrollTop).toBe(1300);
  });

  it("does not move a reader who scrolled up when content grows by itself", () => {
    const { element, update, scrollTo, grow } = setup(1000);
    update({});
    scrollTo(200);
    grow(1300);
    expect(element.scrollTop).toBe(200);
  });
});
