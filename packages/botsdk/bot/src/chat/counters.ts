/** What one hit found: the window's count including this hit, and how long until the window resets. */
export type CounterHit = { count: number; resetMs: number };

/**
 * Fixed-window counters, shared through the `runtime` so limits hold across processes (spec 87).
 * Implementations share the contract in `counters.contract.ts`.
 */
export interface CounterStore {
  /**
   * Counts one hit against `key`. The window opens at the key's first hit and lasts `windowMs`;
   * once it has passed, the next hit opens a new window at 1.
   */
  hit(key: string, windowMs: number): Promise<CounterHit>;
  /**
   * Replaces `key`'s window, whatever was left of it: with a new one of `windowMs` holding one hit,
   * or, with no `windowMs`, with none, so the next hit opens a new window at 1.
   */
  reset(key: string, windowMs?: number): Promise<void>;
}

/** The in-process `CounterStore`: one process, windows held in memory. */
export function createMemoryCounters(): CounterStore {
  const windows = new Map<string, { count: number; expiresAt: number }>();

  /** Opens `key`'s window at `count` hits, and drops it once it has passed. */
  const open = (key: string, count: number, windowMs: number) => {
    const opened = { count, expiresAt: Date.now() + windowMs };
    windows.set(key, opened);
    setTimeout(() => {
      if (windows.get(key) === opened) windows.delete(key);
    }, windowMs).unref?.();
    return opened;
  };

  return {
    async hit(key, windowMs) {
      const now = Date.now();
      const found = windows.get(key);
      const window = found && found.expiresAt > now ? found : open(key, 0, windowMs);
      window.count++;
      return { count: window.count, resetMs: window.expiresAt - now };
    },
    async reset(key, windowMs) {
      windows.delete(key);
      if (windowMs !== undefined) open(key, 1, windowMs);
    },
  };
}
