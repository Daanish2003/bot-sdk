import { describe, expect, it } from "vitest";

// public/sw-logic.js sets `self.swLogic` (it's a classic worker script, loaded by importScripts).
import "../../public/sw-logic.js";

type Request = { method: string; url: string; mode: string };
type Shown = {
  title: string;
  options: { body: string; tag?: string; icon: string; data: { url: string } };
};
type SwLogic = {
  routeOf: (request: Request, selfOrigin: string) => "navigate" | "asset" | "bypass";
  isStale: (cachedAt: number, now: number) => boolean;
  ASSET_MAX_AGE_MS: number;
  notificationOf: (payload: string) => Shown;
  clickUrlOf: (data: unknown, selfOrigin: string) => string;
};
const { routeOf, isStale, ASSET_MAX_AGE_MS, notificationOf, clickUrlOf } = (
  globalThis as unknown as { swLogic: SwLogic }
).swLogic;

const origin = "http://localhost:3000";
const get = (path: string, mode = "cors"): Request => ({
  method: "GET",
  url: `${origin}${path}`,
  mode,
});

describe("the service worker's routing", () => {
  it.each([
    ["the chat API", "/api/chat/conversations"],
    ["the chat's basePath root", "/api/chat"],
    ["auth", "/api/auth/get-session"],
  ])("bypasses %s, even for a navigation", (_name, path) => {
    expect(routeOf(get(path, "navigate"), origin)).toBe("bypass");
    expect(routeOf(get(path, "cors"), origin)).toBe("bypass");
  });

  it("serves hashed build assets cache first", () => {
    expect(routeOf(get("/assets/index-Ab12cd.js", "no-cors"), origin)).toBe("asset");
  });

  it("answers navigations network first", () => {
    expect(routeOf(get("/c/123", "navigate"), origin)).toBe("navigate");
    expect(routeOf(get("/login", "navigate"), origin)).toBe("navigate");
  });

  it("leaves other GETs, writes and other origins to the browser", () => {
    expect(routeOf(get("/icons/icon-192.png", "no-cors"), origin)).toBe("bypass");
    expect(routeOf({ method: "POST", url: `${origin}/assets/x.js`, mode: "cors" }, origin)).toBe(
      "bypass",
    );
    expect(
      routeOf(
        { method: "GET", url: "https://cdn.example.com/assets/x.js", mode: "no-cors" },
        origin,
      ),
    ).toBe("bypass");
  });
});

describe("the asset age trim", () => {
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  it("drops an entry older than 30 days", () => {
    expect(isStale(now - 31 * day, now)).toBe(true);
    expect(ASSET_MAX_AGE_MS).toBe(30 * day);
  });

  it("keeps an entry newer than 30 days", () => {
    expect(isStale(now - 29 * day, now)).toBe(false);
    expect(isStale(now, now)).toBe(false);
  });

  it("treats an entry without a stamp as old", () => {
    expect(isStale(0, now)).toBe(true);
  });
});

describe("a push", () => {
  const push = {
    title: "Ada Lovelace",
    body: "Your train leaves at 9.",
    url: `${origin}/bots/b1`,
    tag: "m1",
  };

  it("shows the Bot's name and the Message's first line, to open the Conversation", () => {
    expect(notificationOf(JSON.stringify(push))).toEqual({
      title: "Ada Lovelace",
      options: {
        body: "Your train leaves at 9.",
        tag: "m1",
        icon: "/icons/icon-192.png",
        data: { url: `${origin}/bots/b1` },
      },
    });
  });

  it("still shows a notification for a payload it can't read", () => {
    for (const payload of ["", "not json", "[]", JSON.stringify({ title: 3 })]) {
      expect(notificationOf(payload)).toMatchObject({
        title: "New message",
        options: { body: "", data: { url: "/" } },
      });
    }
  });
});

describe("a click on a push", () => {
  it("opens the Conversation the push names", () => {
    expect(clickUrlOf({ url: `${origin}/bots/b1` }, origin)).toBe(`${origin}/bots/b1`);
    expect(clickUrlOf({ url: "/bots/b1" }, origin)).toBe(`${origin}/bots/b1`);
  });

  it("opens the app instead of another origin or a missing URL", () => {
    expect(clickUrlOf({ url: "https://evil.example/phish" }, origin)).toBe(`${origin}/`);
    expect(clickUrlOf({ url: "javascript:alert(1)" }, origin)).toBe(`${origin}/`);
    expect(clickUrlOf(undefined, origin)).toBe(`${origin}/`);
  });
});
