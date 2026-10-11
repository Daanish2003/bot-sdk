import { randomUUID } from "node:crypto";

import { createAuth, type AuthConfig } from "@ai-chat/auth";
import { createDb } from "@ai-chat/db";
import { createCaptureMailbox, createMemorySender } from "@ai-chat/email";
import { redisStore } from "@ai-chat/chat-sdk/server";

import { afterAll, describe, expect, it } from "vitest";

// Redis suites need TEST_REDIS_URL (the throwaway container, 127.0.0.1:6381). Every key sits under
// a random prefix, so runs never see each other's counts.
const redisUrl = process.env.TEST_REDIS_URL;
const BASE = "http://localhost:3000";
const RESET_TO = `${BASE}/reset-password`;
const env: AuthConfig = {
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "redis-limits-secret-0123456789abcdef0123",
  APP_NAME: "Acme Chat",
  GITHUB_CLIENT_ID: "test-github-client-id",
  GITHUB_CLIENT_SECRET: "test-github-client-secret",
  GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
};
const database = createDb({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" });
const noChatData = { deleteChatData: async () => {} };
const log = { error: () => {} };

afterAll(async () => {
  await database.$client.end();
});

// Each request comes from its own address, so the in-memory limits never see another test's hits.
function fromAddress() {
  return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

function requestReset(auth: ReturnType<typeof createAuth>, email: string, ip: string) {
  return auth.handler(
    new Request(`${BASE}/api/auth/request-password-reset`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({ email, redirectTo: RESET_TO }),
    }),
  );
}

describe("rate limits in memory (no Redis)", () => {
  it("rate limits in memory and boots without Redis", async () => {
    const auth = createAuth(env, database, createMemorySender(), log, noChatData, {
      rateLimit: true,
    });
    const ip = fromAddress();

    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await requestReset(auth, "nobody@example.com", ip)).status);
    }

    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe.skipIf(!redisUrl)("rate limits and mailbox on Redis", () => {
  const prefix = `ai-chat-131:${randomUUID()}:`;
  const stores: { close(): Promise<void> }[] = [];
  function openStore(storePrefix: string) {
    const store = redisStore({ url: redisUrl ?? "", prefix: storePrefix });
    stores.push(store);
    return store;
  }
  afterAll(async () => {
    for (const store of stores) await store.close();
  });

  it("the store counts within a window and forgets it once the window passes", async () => {
    const store = openStore(`${prefix}store:`);

    expect(await store.increment("counted", 1)).toBe(1);
    expect(await store.increment("counted", 1)).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await store.increment("counted", 1)).toBe(1);
  });

  it("the store sets, reads, takes and deletes values", async () => {
    const store = openStore(`${prefix}values:`);

    await store.set("kept", "value");
    expect(await store.get("kept")).toBe("value");
    expect(await store.getAndDelete("kept")).toBe("value");
    expect(await store.get("kept")).toBeNull();
    await store.set("gone", "value");
    await store.delete("gone");
    expect(await store.get("gone")).toBeNull();
  });

  it("two auth instances on one Redis share one count: the fourth reset request through the second is refused", async () => {
    const shared = `${prefix}auth:`;
    const first = createAuth(env, database, createMemorySender(), log, noChatData, {
      rateLimit: true,
      rateLimitCounter: openStore(shared),
    });
    const second = createAuth(env, database, createMemorySender(), log, noChatData, {
      rateLimit: true,
      rateLimitCounter: openStore(shared),
    });
    const ip = fromAddress();

    const statuses = [
      (await requestReset(first, "nobody@example.com", ip)).status,
      (await requestReset(first, "nobody@example.com", ip)).status,
      (await requestReset(first, "nobody@example.com", ip)).status,
      (await requestReset(second, "nobody@example.com", ip)).status,
    ];

    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("with Redis, sessions stay in Postgres: one signed in before Redis is listed, and signed out", async () => {
    const withoutRedis = createAuth(env, database, createMemorySender(), log, noChatData, {
      rateLimit: true,
    });
    const auth = createAuth(env, database, createMemorySender(), log, noChatData, {
      rateLimit: true,
      rateLimitCounter: openStore(`${prefix}sessions:`),
    });
    const email = `stays-${randomUUID()}@example.com`;
    const post = (path: string, body: object, cookie?: string) =>
      new Request(`${BASE}/api/auth/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE,
          "x-forwarded-for": fromAddress(),
          ...(cookie && { cookie }),
        },
        body: JSON.stringify(body),
      });
    await withoutRedis.handler(
      post("sign-up/email", { name: "Stays", email, password: "stays-password-1" }),
    );
    await database.$client.query(`update "user" set email_verified = true where email = $1`, [
      email,
    ]);
    const signIn = async () => {
      const response = await withoutRedis.handler(
        post("sign-in/email", { email, password: "stays-password-1" }),
      );
      expect(response.status).toBe(200);
      return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    };
    const current = await signIn();
    await signIn();

    const listed = await auth.api.listSessions({ headers: new Headers({ cookie: current }) });
    expect(listed).toHaveLength(2);

    await auth.handler(post("revoke-other-sessions", {}, current));
    const { rows } = await database.$client.query(
      `select s.id from "session" s join "user" u on u.id = s.user_id where u.email = $1`,
      [email],
    );
    expect(rows).toHaveLength(1);
  });

  it("with Redis, a message captured through one mailbox is read through another", async () => {
    const storePrefix = `${prefix}mail:`;
    const sending = createCaptureMailbox({
      from: "AI Chat <no-reply@example.com>",
      store: openStore(storePrefix),
    });
    const reading = createCaptureMailbox({
      from: "AI Chat <no-reply@example.com>",
      store: openStore(storePrefix),
    });
    const address = `mail-${randomUUID()}@example.com`;
    const { renderTemplate } = await import("@ai-chat/email");
    await sending.sender.send(
      await renderTemplate("verify-email", address, {
        appName: "Acme Chat",
        url: "https://chat.example.com/verify?token=abc",
      }),
    );

    const messages = await reading.read(address);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ template: "verify-email" });
  });
});
