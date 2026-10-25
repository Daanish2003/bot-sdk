import { describe, expect, it } from "vitest";

import { createBotSdk } from "../../../../core/server/create-chat";
import { bot } from "../../../../plugins/bot/server/plugin";
import { knowledge } from "../../../../plugins/knowledge/server/plugin";
import { models } from "../../../../plugins/models/server/plugin";
import { memoryRuntime } from "../../../../core/server/runtime";
import { resolveRateLimits, type RateLimits } from "../../../../core/server/rate-limits";
import { RateLimitedError } from "../../../../core/client/rate-limit";
import { createTestSdk } from "../../../support/deps";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";
import { chatRpc, sendAs } from "../../../support/sdk";
import { testDatabaseUrl } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

/** The RPC routes of a Bot-only SDK that spec 87's per-user limits cover, with the override that turns each on. */
const rpcCases = [
  {
    name: "credential save and check",
    route: "credentials/save",
    rateLimits: { credentialSave: { limit: 1, windowSeconds: 60 } },
  },
  {
    name: "Knowledge upload (shares the attachment bucket)",
    route: "knowledge/upload",
    rateLimits: { attachmentUpload: { limit: 1, windowSeconds: 60 } },
  },
  {
    name: "Knowledge document upload (shares the attachment bucket)",
    route: "knowledge/uploadDocument",
    rateLimits: { attachmentUpload: { limit: 1, windowSeconds: 60 } },
  },
  {
    name: "Bot file upload (shares the attachment bucket)",
    route: "bot/upload",
    rateLimits: { attachmentUpload: { limit: 1, windowSeconds: 60 } },
  },
];

/** The Bot-only plugins and features that serve every route in `rpcCases`, with the Computer they need. */
const botOnly = () => ({
  computer: fakeComputerProvider().provider,
  plugins: [bot()],
  features: [knowledge()],
});

/** An RPC call to `route`. The limit is checked before the body is read, so the body can be empty. */
const rpcCall = (route: string) =>
  new Request(`http://localhost/api/chat/rpc/${route}`, { method: "POST", body: "{}" });

describe.each(rpcCases)("$name rate limits", ({ route, rateLimits }) => {
  it("answers 429 with Retry-After once a user passes the limit, and another user is unaffected", async () => {
    const user = await insertUser();
    const other = await insertUser();
    const deps = createTestSdk({
      ...botOnly(),
      rateLimits: resolveRateLimits(rateLimits),
    });

    const first = await sendAs(rpcCall(route), user, deps);
    const limited = await sendAs(rpcCall(route), user, deps);
    const others = await sendAs(rpcCall(route), other, deps);

    expect(first.status).not.toBe(404);
    expect(first.status).not.toBe(429);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(others.status).not.toBe(429);
  });

  it("never refuses when its limit is turned off with false", async () => {
    const user = await insertUser();
    const off = Object.fromEntries(
      Object.keys(rateLimits).map((key) => [key, false]),
    ) as RateLimits;
    const deps = createTestSdk({ ...botOnly(), rateLimits: resolveRateLimits(off) });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      statuses.push((await sendAs(rpcCall(route), user, deps)).status);
    }

    expect(statuses.every((status) => status !== 429)).toBe(true);
  });
});

it("takes its limit from createBotSdk's rateLimits override", async () => {
  const user = await insertUser();
  const chat = createBotSdk({
    databaseUrl: testDatabaseUrl,
    getUser: () => ({ id: user.id }),
    keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
    basePath: "/api/chat",
    runtime: memoryRuntime(),
    rateLimits: { credentialSave: { limit: 1, windowSeconds: 60 } },
    plugins: [models(), bot()],
  });

  const first = await chat.handler(rpcCall("credentials/save"));
  const second = await chat.handler(rpcCall("credentials/save"));

  expect(first.status).not.toBe(429);
  expect(second.status).toBe(429);
});

it("defaults to spec 87's numbers: 30 uploads per 10 minutes, 10 saves a minute", () => {
  expect(resolveRateLimits()).toMatchObject({
    attachmentUpload: { limit: 30, windowSeconds: 600 },
    credentialSave: { limit: 10, windowSeconds: 60 },
  });
});

it("surfaces the limit to the typed client as a RateLimitedError with the retry time", async () => {
  const user = await insertUser();
  const client = chatRpc({
    user,
    deps: createTestSdk({
      plugins: [bot()],
      rateLimits: resolveRateLimits({ attachmentUpload: { limit: 0, windowSeconds: 60 } }),
    }),
  });

  const caught = await client.bot
    .upload({ file: new File(["hi"], "a.txt", { type: "text/plain" }) })
    .catch((error: unknown) => error);

  expect(caught).toBeInstanceOf(RateLimitedError);
  expect((caught as RateLimitedError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
});
