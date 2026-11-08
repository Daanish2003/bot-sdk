import { describe, expect, it } from "vitest";

import { smsApiBaseOf } from "./sms-api-base";

describe("smsApiBaseOf", () => {
  it("is Telnyx's own when SMS_API_BASE is unset or blank", () => {
    expect(smsApiBaseOf({ BETTER_AUTH_URL: "https://chat.example.com" })).toBeUndefined();
    expect(
      smsApiBaseOf({ BETTER_AUTH_URL: "https://chat.example.com", SMS_API_BASE: "" }),
    ).toBeUndefined();
  });

  it("is the lab phone on this machine for a Host on this machine", () => {
    for (const base of ["http://localhost:4010", "http://127.0.0.1:4010/"]) {
      expect(smsApiBaseOf({ BETTER_AUTH_URL: "http://localhost:3001", SMS_API_BASE: base })).toBe(
        base,
      );
    }
  });

  it("refuses it on a Host that isn't on this machine", () => {
    expect(() =>
      smsApiBaseOf({
        BETTER_AUTH_URL: "https://chat.example.com",
        SMS_API_BASE: "http://localhost:4010",
      }),
    ).toThrow("SMS_API_BASE needs a localhost BETTER_AUTH_URL");
  });

  // Every account's Telnyx key goes to it as a Bearer token (#1174 review).
  it.each([
    "https://mock.example.com",
    "http://localhost.example.com:4010",
    "http://10.0.0.5:4010",
  ])("refuses %s, which isn't on this machine", (base) => {
    expect(() =>
      smsApiBaseOf({ BETTER_AUTH_URL: "http://localhost:3001", SMS_API_BASE: base }),
    ).toThrow("SMS_API_BASE must be the lab phone on localhost");
  });
});
