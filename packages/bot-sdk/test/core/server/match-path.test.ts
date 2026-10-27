import { describe, expect, it } from "vitest";

import { matchPath } from "@botsdk/bot/plugin";

describe("matchPath", () => {
  it("gives a pattern's `:name` segments, each one segment that isn't empty", () => {
    expect(matchPath("/routines/webhook/:token", "/routines/webhook/abc")).toEqual({
      token: "abc",
    });
    expect(matchPath("/routines/webhook/:token", "/routines/webhook/")).toBeNull();
    expect(matchPath("/routines/webhook/:token", "/routines/webhook/abc/more")).toBeNull();
  });

  it("matches a last `*` to one segment or more, never to none", () => {
    expect(matchPath("/screens/*", "/screens/token")).toEqual({ "*": "token" });
    expect(matchPath("/screens/*", "/screens/token/vnc.html")).toEqual({ "*": "token/vnc.html" });
    expect(matchPath("/screens/*", "/screens/")).toBeNull();
    expect(matchPath("/screens/*", "/screens")).toBeNull();
    expect(matchPath("/screens/*", "/screens//vnc.html")).toBeNull();
  });
});
