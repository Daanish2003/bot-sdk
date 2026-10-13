import { describe, expect, it } from "vitest";

import { trustedIpHeadersOf } from "./trusted-ip";

describe("trustedIpHeadersOf", () => {
  it("is undefined when TRUSTED_IP_HEADERS is unset or blank, so Better Auth's default applies", () => {
    expect(trustedIpHeadersOf({})).toBeUndefined();
    expect(trustedIpHeadersOf({ TRUSTED_IP_HEADERS: " " })).toBeUndefined();
  });

  it("lists the header names in order, trimmed and lowercased", () => {
    expect(trustedIpHeadersOf({ TRUSTED_IP_HEADERS: "CF-Connecting-IP, x-forwarded-for" })).toEqual(
      ["cf-connecting-ip", "x-forwarded-for"],
    );
  });
});
