import { describe, expect, it } from "vitest";

import type { PubSub } from "../../../../core/server/chat/pubsub";

/**
 * The contract every `PubSub` implementation meets (ADR 0006). An implementation proves it by
 * running this suite unchanged, with its own factory:
 *
 *   pubsubContract("redis", () => createRedisPubSub(...));
 *
 * It uses only the public interface. Delivery is asynchronous in some implementations, so the
 * tests wait a little after a publish before they assert on what arrived. Channel names are fresh
 * per test, so a factory may share one broker between tests.
 */
export function pubsubContract(name: string, make: () => PubSub | Promise<PubSub>) {
  describe(`PubSub contract: ${name}`, () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    const channel = () => `test:${crypto.randomUUID()}`;

    /** Records what a handler receives, in order. */
    function recorder() {
      const received: string[] = [];
      return { received, handler: (message: string) => void received.push(message) };
    }

    it("delivers a published message to a subscriber of its channel", async () => {
      const pubsub = await make();
      const name = channel();
      const seen = recorder();
      await pubsub.subscribe(name, seen.handler);

      await pubsub.publish(name, "stop");
      await settle();

      expect(seen.received).toEqual(["stop"]);
    });

    it("delivers to every subscriber of the channel", async () => {
      const pubsub = await make();
      const name = channel();
      const first = recorder();
      const second = recorder();
      await pubsub.subscribe(name, first.handler);
      await pubsub.subscribe(name, second.handler);

      await pubsub.publish(name, "stop");
      await settle();

      expect(first.received).toEqual(["stop"]);
      expect(second.received).toEqual(["stop"]);
    });

    it("delivers only on the channel published to", async () => {
      const pubsub = await make();
      const name = channel();
      const other = channel();
      const seen = recorder();
      await pubsub.subscribe(name, seen.handler);

      await pubsub.publish(other, "stop");
      await settle();

      expect(seen.received).toEqual([]);
    });

    it("delivers in publish order", async () => {
      const pubsub = await make();
      const name = channel();
      const seen = recorder();
      await pubsub.subscribe(name, seen.handler);

      await pubsub.publish(name, "a");
      await pubsub.publish(name, "b");
      await pubsub.publish(name, "c");
      await settle();

      expect(seen.received).toEqual(["a", "b", "c"]);
    });

    it("stops delivering to a subscriber once it unsubscribes", async () => {
      const pubsub = await make();
      const name = channel();
      const seen = recorder();
      const unsubscribe = await pubsub.subscribe(name, seen.handler);

      await pubsub.publish(name, "before");
      await settle();
      await unsubscribe();
      await pubsub.publish(name, "after");
      await settle();

      expect(seen.received).toEqual(["before"]);
    });

    it("unsubscribing one subscriber leaves the others receiving", async () => {
      const pubsub = await make();
      const name = channel();
      const leaving = recorder();
      const staying = recorder();
      const unsubscribe = await pubsub.subscribe(name, leaving.handler);
      await pubsub.subscribe(name, staying.handler);

      await unsubscribe();
      await pubsub.publish(name, "stop");
      await settle();

      expect(leaving.received).toEqual([]);
      expect(staying.received).toEqual(["stop"]);
    });

    it("is at most once: a message published with no subscriber is gone, not replayed to a later one", async () => {
      const pubsub = await make();
      const name = channel();
      await pubsub.publish(name, "early");

      const seen = recorder();
      await pubsub.subscribe(name, seen.handler);
      await settle();

      expect(seen.received).toEqual([]);
    });
  });
}
