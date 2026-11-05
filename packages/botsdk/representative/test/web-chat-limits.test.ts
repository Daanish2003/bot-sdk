import { describe, expect, it } from "vitest";

import { clientIpOf } from "../src/server/web-chat-limits";

/* The key a client's IP is counted under (#1173 review): one key per address, however it's spelt. */

const keyOf = (ip: string | null | undefined) =>
  clientIpOf(new Request("http://localhost/"), () => ip);

describe("an IP's key", () => {
  it("is an IPv4 address as given, trimmed", () => {
    expect(keyOf(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("is the IPv4 address an IPv4-mapped IPv6 address carries", () => {
    expect(keyOf("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(keyOf("::FFFF:cb00:7107")).toBe("203.0.113.7");
  });

  it("is one for every spelling of an IPv6 address", () => {
    const spellings = [
      "2001:db8::1",
      "2001:DB8:0:0:0:0:0:1",
      "2001:0db8:0000:0000:0000:0000:0000:0001",
      "[2001:db8::1]",
    ];
    expect(new Set(spellings.map(keyOf)).size).toBe(1);
  });

  it("is an IPv6 address's /64, which one subscriber holds", () => {
    expect(keyOf("2001:db8:1:2:aaaa::1")).toBe(keyOf("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(keyOf("2001:db8:1:2::1")).not.toBe(keyOf("2001:db8:1:3::1"));
  });

  it("is nothing when the Host says nothing", () => {
    expect(keyOf(undefined)).toBeUndefined();
    expect(keyOf(null)).toBeUndefined();
    expect(keyOf("  ")).toBeFalsy();
  });

  it("keeps a value that is no address, cut short", () => {
    expect(keyOf("Not-An-IP")).toBe("not-an-ip");
    expect(keyOf("x".repeat(100))).toHaveLength(64);
  });
});
