import { describe, expect, it } from "vitest";

import { RateLimitedError, throwIfRateLimited } from "../../../core/client/rate-limit";

describe("throwIfRateLimited", () => {
  it("throws a RateLimitedError carrying Retry-After when the server answers 429", () => {
    const limited = new Response("{}", { status: 429, headers: { "Retry-After": "7" } });

    const caught = (() => {
      try {
        throwIfRateLimited(limited);
      } catch (error) {
        return error;
      }
    })();

    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).retryAfterSeconds).toBe(7);
  });

  it("passes every other response through unchanged", () => {
    const response = new Response("ok", { status: 200 });

    expect(throwIfRateLimited(response)).toBe(response);
  });
});
