import { act } from "@testing-library/react";
import { vi } from "vitest";

import type { BotChange, BotChanges } from "../../../plugins/bot/shared/changes";

/**
 * A stand-in for the browser's `EventSource`, so a test can send the data-less `changed` hint of the
 * `/events` route, and open and reopen the connection as a network does.
 */
export class FakeEventSource {
  static sources: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.sources.push(this);
    // The connection opens a moment after the page asks for it.
    setTimeout(() => {
      if (!this.closed) this.onopen?.();
    }, 0);
  }

  close() {
    this.closed = true;
  }

  static get open() {
    return FakeEventSource.sources.filter((source) => !source.closed);
  }

  /** Sends the hint to every open connection. */
  static hint() {
    for (const source of FakeEventSource.open) {
      source.onmessage?.({ data: JSON.stringify({ type: "changed" }) });
    }
  }

  /** Opens every connection again, as the browser does after a dropped one. */
  static reconnect() {
    for (const source of FakeEventSource.open) source.onopen?.();
  }
}

/** Replaces `EventSource` with the fake; undo it with `vi.unstubAllGlobals()`. */
export function stubEventSource() {
  FakeEventSource.sources = [];
  vi.stubGlobal("EventSource", FakeEventSource);
}

/** Lets the client's requests and renders settle. */
export const settle = (ms = 20) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** Sends the `changed` hint, then lets the client fetch and render what it says. */
export const hint = () =>
  act(async () => {
    FakeEventSource.hint();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

/** A Bot's change log as the server keeps it, for a stubbed `conversations.changes`. */
export function changeLog() {
  const entries: BotChange[] = [];
  let seq = 0;
  /** The `since` of each `conversations.changes` call. */
  const calls: number[] = [];
  return {
    calls,
    get last() {
      return seq;
    },
    record<K extends BotChange["kind"]>(
      kind: K,
      refId: string,
      data: Extract<BotChange, { kind: K }>["data"],
    ) {
      entries.push({ seq: ++seq, kind, refId, at: new Date(), data } as BotChange);
      return seq;
    },
    /** What `conversations.changes` answers: `reload` for a cursor the log doesn't hold. */
    since(since: number): BotChanges {
      calls.push(since);
      if (since > seq) return { reload: true };
      const changes = entries.filter((entry) => entry.seq > since);
      if (changes[0] && changes[0].seq !== since + 1) return { reload: true };
      return { reload: false, changes };
    },
    /** Forgets the changes up to `upTo`, as the retention limit does. */
    trim(upTo: number) {
      entries.splice(0, entries.length, ...entries.filter((entry) => entry.seq > upTo));
    },
  };
}
