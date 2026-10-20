import type { ChatgptAccessToken } from "@ai-chat/auth/chatgpt";
import { describe, expect, it } from "vitest";

import { cachedTokenFor, linkedCredentialsOf } from "./linked-credentials";

const hookFor = (token: ChatgptAccessToken) => linkedCredentialsOf(async () => token);

describe("the linkedCredentials hook", () => {
  it("answers a ChatGPT access token as OpenAI's apiKey", async () => {
    const hook = hookFor({ status: "ok", accessToken: "plan-token" });

    expect(await hook("user-1", "openai")).toEqual({ apiKey: "plan-token" });
  });

  it("answers nothing for a user who has not linked ChatGPT", async () => {
    expect(await hookFor({ status: "none" })("user-1", "openai")).toBeNull();
  });

  it("answers needs-reconnect when the token can't be refreshed", async () => {
    expect(await hookFor({ status: "needs-reconnect" })("user-1", "openai")).toBe(
      "needs-reconnect",
    );
  });

  it("answers nothing for a service other than OpenAI, without asking for a token", async () => {
    const hook = linkedCredentialsOf(async () => {
      throw new Error("should not be asked");
    });

    expect(await hook("user-1", "anthropic")).toBeNull();
  });

  it("asks for the token of the user it was asked about", async () => {
    const asked: string[] = [];
    const hook = linkedCredentialsOf(async (userId) => {
      asked.push(userId);
      return { status: "none" };
    });

    await hook("user-7", "openai");

    expect(asked).toEqual(["user-7"]);
  });
});

describe("the per-user token cache", () => {
  const okUntil = (expiresAt: Date, accessToken = "plan-token"): ChatgptAccessToken => ({
    status: "ok",
    accessToken,
    expiresAt,
  });

  it("shares one in-flight token request among concurrent calls for a user", async () => {
    let requests = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const tokenFor = cachedTokenFor(async () => {
      requests += 1;
      await released;
      return okUntil(new Date(Date.now() + 3_600_000));
    });

    const calls = Array.from({ length: 5 }, () => tokenFor("user-1"));
    release();
    const tokens = await Promise.all(calls);

    expect(requests).toBe(1);
    expect(tokens.every((token) => token.status === "ok")).toBe(true);
  });

  it("reuses a good token until shortly before it expires", async () => {
    let now = 1_000_000;
    let requests = 0;
    const tokenFor = cachedTokenFor(
      async () => {
        requests += 1;
        return okUntil(new Date(now + 10 * 60_000), `token-${requests}`);
      },
      () => now,
    );

    await tokenFor("user-1");
    now += 20_000;
    const again = await tokenFor("user-1");
    expect(requests).toBe(1);
    expect(again).toMatchObject({ accessToken: "token-1" });

    now += 5 * 60_000;
    expect(await tokenFor("user-1")).toMatchObject({ accessToken: "token-2" });
    expect(requests).toBe(2);
  });

  it("asks again before a token that is about to expire could be handed out", async () => {
    const now = 1_000_000;
    let requests = 0;
    const tokenFor = cachedTokenFor(
      async () => {
        requests += 1;
        return okUntil(new Date(now + 10_000));
      },
      () => now,
    );

    await tokenFor("user-1");
    await tokenFor("user-1");

    expect(requests).toBe(2);
  });

  it("keeps users apart, and does not cache a missing or broken link", async () => {
    const asked: string[] = [];
    const tokenFor = cachedTokenFor(async (userId) => {
      asked.push(userId);
      return { status: "none" };
    });

    await tokenFor("user-1");
    await tokenFor("user-1");
    await tokenFor("user-2");

    expect(asked).toEqual(["user-1", "user-1", "user-2"]);
  });

  it("lets a failed request be retried by the next call", async () => {
    let requests = 0;
    const tokenFor = cachedTokenFor(async () => {
      requests += 1;
      if (requests === 1) throw new Error("db down");
      return okUntil(new Date(Date.now() + 3_600_000));
    });

    await expect(tokenFor("user-1")).rejects.toThrow("db down");
    expect(await tokenFor("user-1")).toMatchObject({ status: "ok" });
  });
});
