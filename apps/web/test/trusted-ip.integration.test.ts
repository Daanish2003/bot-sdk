import { createAuth, type AuthConfig } from "@ai-chat/auth";
import { createDb } from "@ai-chat/db";
import { createMemorySender } from "@ai-chat/email";

import { afterAll, describe, expect, it } from "vitest";

// Each test draws fresh header values, so the in-memory limits never see another test's hits.
const BASE = "http://localhost:3000";
const env: AuthConfig = {
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "trusted-ip-secret-0123456789abcdef0123",
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

function fromAddress() {
  return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

function requestReset(auth: ReturnType<typeof createAuth>, headers: Record<string, string>) {
  return auth.handler(
    new Request(`${BASE}/api/auth/request-password-reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      body: JSON.stringify({ email: "nobody@example.com", redirectTo: `${BASE}/reset-password` }),
    }),
  );
}

describe("client IP from TRUSTED_IP_HEADERS", () => {
  it("with a trusted header set, clients with different header values have separate buckets", async () => {
    const auth = createAuth(env, database, createMemorySender(), log, noChatData, {
      rateLimit: true,
      trustedIpHeaders: ["cf-connecting-ip"],
    });
    const first = fromAddress();
    const second = fromAddress();

    const firstStatuses = [];
    for (let i = 0; i < 4; i++) {
      firstStatuses.push((await requestReset(auth, { "cf-connecting-ip": first })).status);
    }
    const secondStatus = (await requestReset(auth, { "cf-connecting-ip": second })).status;

    expect(firstStatuses).toEqual([200, 200, 200, 429]);
    expect(secondStatus).toBe(200);
  });

  it("unset, the default header (x-forwarded-for) decides the bucket and cf-connecting-ip is ignored", async () => {
    const auth = createAuth(env, database, createMemorySender(), log, noChatData, {
      rateLimit: true,
    });
    const forwarded = fromAddress();

    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (
          await requestReset(auth, {
            "x-forwarded-for": forwarded,
            "cf-connecting-ip": fromAddress(),
          })
        ).status,
      );
    }

    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
