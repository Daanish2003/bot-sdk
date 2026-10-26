import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";

import { reviewerSystemPrompt } from "../../plugins/bot/server/safety";
import type { ReviewVerdict } from "../../plugins/bot/server/safety";
import type { ModelsDeps } from "../../plugins/models/server/internal";
import { createFakeAdapter, round, text } from "./fake-adapter";

type Chunks = ReturnType<typeof round>;

/** A reviewer's round whose reply is `verdict`. */
export const verdictRound = (verdict: ReviewVerdict): Chunks =>
  round(text(JSON.stringify(verdict)));

/** The verdict the default fake reviewer gives every call. */
export const passVerdict: ReviewVerdict = {
  outcome: "pass",
  reason: "The user asked for it.",
  summary: "Run a command",
};

/** Whether a model call is an Auto-review: it sends the reviewer's system prompt. */
export function isReviewCall(options: TextOptions): boolean {
  const [first] = (options.systemPrompts ?? []) as unknown[];
  const content =
    typeof first === "object" && first !== null ? (first as { content?: unknown }).content : first;
  return content === reviewerSystemPrompt;
}

export type FakeReviewer = {
  adapter: AnyTextAdapter;
  /** The options of every review call, in order. */
  calls: TextOptions[];
};

/**
 * A fake Auto-review Model: each call plays `reply`'s round (a pass by default), as many times as
 * it is called. A reply that is a promise is awaited until the call is aborted, for a slow reviewer;
 * one that throws is a reviewer failure.
 */
export function fakeReviewer(
  reply: (options: TextOptions) => Chunks | Promise<Chunks> = () => verdictRound(passVerdict),
): FakeReviewer {
  const calls: TextOptions[] = [];
  const { adapter: base } = createFakeAdapter({ rounds: [] });
  const adapter: AnyTextAdapter = {
    ...base,
    chatStream: async function* (options: TextOptions) {
      calls.push(options);
      const signal = options.request?.signal ?? undefined;
      const aborted = new Promise<never>((_, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      aborted.catch(() => {});
      const chunks = await Promise.race([Promise.resolve(reply(options)), aborted]);
      yield* chunks;
    },
  };
  return { adapter, calls };
}

/**
 * `adapterFor` with each Auto-review call (`isReviewCall`) sent to `reviewAdapterFor`'s adapter
 * for the same Model, and every other call to its own.
 */
export function withReviewer(
  adapterFor: ModelsDeps["adapterFor"],
  reviewAdapterFor: (model: string) => AnyTextAdapter,
): ModelsDeps["adapterFor"] {
  return (model, credentials, options) => {
    const own = adapterFor(model, credentials, options);
    return new Proxy(own, {
      get(target, property, receiver) {
        if (property !== "chatStream") return Reflect.get(target, property, receiver);
        return (call: TextOptions) =>
          isReviewCall(call) ? reviewAdapterFor(model).chatStream(call) : target.chatStream(call);
      },
    });
  };
}
