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
}

/** The in-process `CounterStore`: one process, windows held in memory. */
export function createMemoryCounters(): CounterStore {
  const windows = new Map<string, { count: number; expiresAt: number }>();

  return {
    async hit(key, windowMs) {
      const now = Date.now();
      let window = windows.get(key);
      if (!window || window.expiresAt <= now) {
        const opened = { count: 0, expiresAt: now + windowMs };
        window = opened;
        windows.set(key, window);
        // Drop the window once it has passed, so the map holds only open windows.
        setTimeout(() => {
          if (windows.get(key) === opened) windows.delete(key);
        }, windowMs).unref?.();
      }
      window.count++;
      return { count: window.count, resetMs: window.expiresAt - now };
    },
  };
}
