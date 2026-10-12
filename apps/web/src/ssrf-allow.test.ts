import { describe, expect, it } from "vitest";

import { ssrfAllowHostsOf } from "./ssrf-allow";

describe("ssrfAllowHostsOf", () => {
  it("allows nothing when SSRF_ALLOW_HOSTS is unset or blank", () => {
    expect(ssrfAllowHostsOf({ BETTER_AUTH_URL: "https://chat.example.com" })).toEqual([]);
    expect(
      ssrfAllowHostsOf({ BETTER_AUTH_URL: "https://chat.example.com", SSRF_ALLOW_HOSTS: " " }),
    ).toEqual([]);
  });

  it("lists the hosts on a localhost BETTER_AUTH_URL", () => {
    expect(
      ssrfAllowHostsOf({
        BETTER_AUTH_URL: "http://localhost:3100",
        SSRF_ALLOW_HOSTS: "localhost:11534, 127.0.0.1",
      }),
    ).toEqual(["localhost:11534", "127.0.0.1"]);
  });

  it.each([
    "https://chat.example.com",
    "https://localhost.example.com",
    "http://10.0.0.5:3000",
    "https://app.localhost.evil.test",
  ])("refuses the allowance on BETTER_AUTH_URL %s", (betterAuthUrl) => {
    expect(() =>
      ssrfAllowHostsOf({ BETTER_AUTH_URL: betterAuthUrl, SSRF_ALLOW_HOSTS: "localhost:11534" }),
    ).toThrow(/localhost BETTER_AUTH_URL/);
  });
});
