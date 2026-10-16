import { describe, expect, it } from "vitest";

import type { CounterStore } from "../../../../core/server/chat/counters";

/**
 * The contract every `CounterStore` meets (spec 87, rate limits). An implementation proves it by
 * running this suite unchanged, with its own factory:
 *
 *   counterStoreContract("redis", () => createRedisCounters(...));
 *
 * Each test uses fresh keys, so a factory may share one store between tests.
 */
export function counterStoreContract(
  name: string,
  make: () => CounterStore | Promise<CounterStore>,
) {
  describe(`CounterStore contract: ${name}`, () => {
    const freshKey = () => `counter-${crypto.randomUUID()}`;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it("counts hits within a window", async () => {
      const counters = await make();
      const key = freshKey();

      expect((await counters.hit(key, 60_000)).count).toBe(1);
      expect((await counters.hit(key, 60_000)).count).toBe(2);
      expect((await counters.hit(key, 60_000)).count).toBe(3);
    });

    it("reports how long until the window resets, at most the window's length", async () => {
      const counters = await make();
      const key = freshKey();

      const first = await counters.hit(key, 60_000);
      const second = await counters.hit(key, 60_000);

      expect(first.resetMs).toBeGreaterThan(0);
      expect(first.resetMs).toBeLessThanOrEqual(60_000);
      expect(second.resetMs).toBeLessThanOrEqual(first.resetMs);
    });

    it("resets after the window has passed, so the next hit counts from one again", async () => {
      const counters = await make();
      const key = freshKey();
      await counters.hit(key, 200);
      await counters.hit(key, 200);

      await sleep(400);

      expect((await counters.hit(key, 200)).count).toBe(1);
    });

    it("keeps separate keys apart", async () => {
      const counters = await make();
      const a = freshKey();
      const b = freshKey();
      await counters.hit(a, 60_000);
      await counters.hit(a, 60_000);

      expect((await counters.hit(b, 60_000)).count).toBe(1);
      expect((await counters.hit(a, 60_000)).count).toBe(3);
    });
  });
}
