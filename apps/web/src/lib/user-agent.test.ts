import { describe, expect, it } from "vitest";

import { describeUserAgent } from "./user-agent";

const chromeWindows =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const edgeWindows = `${chromeWindows} Edg/125.0.0.0`;
const safariIphone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const firefoxLinux = "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0";
const chromeAndroid =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
const safariMac =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

describe("describeUserAgent", () => {
  it.each([
    [chromeWindows, "Chrome on Windows"],
    [edgeWindows, "Edge on Windows"],
    [safariIphone, "Safari on iPhone"],
    [firefoxLinux, "Firefox on Linux"],
    [chromeAndroid, "Chrome on Android"],
    [safariMac, "Safari on macOS"],
  ])("names the browser and system of %s", (userAgent, expected) => {
    expect(describeUserAgent(userAgent)).toBe(expected);
  });

  it("falls back to a generic name when the agent is missing or unknown", () => {
    expect(describeUserAgent(null)).toBe("Unknown device");
    expect(describeUserAgent("")).toBe("Unknown device");
    expect(describeUserAgent("curl/8.4.0")).toBe("Unknown device");
  });
});
