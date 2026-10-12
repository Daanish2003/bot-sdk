import { afterEach, describe, expect, it, vi } from "vitest";

import { RateLimitedError, rateLimitedErrorOf, runFetch } from "../../../core/client/rate-limit";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runFetch", () => {
  it("throws a RateLimitedError carrying Retry-After when the server answers 429", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("{}", { status: 429, headers: { "Retry-After": "7" } }),
    );

    const caught = await runFetch("http://localhost/api/chat/run", { method: "POST" }).catch(
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).retryAfterSeconds).toBe(7);
  });

  it("passes every other response through unchanged", async () => {
    vi.stubGlobal("fetch", async () => new Response("ok", { status: 200 }));

    const response = await runFetch("http://localhost/api/chat/run", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

describe("rateLimitedErrorOf", () => {
  it("finds the RateLimitedError behind a wrapped connection error", () => {
    const limited = new RateLimitedError(3);
    const wrapped = new Error("Stream response body read failed", { cause: limited });

    expect(rateLimitedErrorOf(wrapped)).toBe(limited);
  });

  it("is null for any other error", () => {
    expect(rateLimitedErrorOf(new Error("boom"))).toBeNull();
  });
});
