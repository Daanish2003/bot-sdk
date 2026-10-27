import { RateLimitedError } from "@botsdk/client";
import { describe, expect, it } from "vitest";

import { createHttpHandler } from "../../../../core/http";
import { createBotSdk } from "../../../../core/server/create-chat";
import { knowledge } from "../../../../plugins/knowledge/server/plugin";
import { memoryRuntime } from "../../../../core/server/runtime";
import { resolveRateLimits, type RateLimits } from "../../../../core/server/rate-limits";
import { createTestSdk } from "../../../support/deps";
import { fakeComputerProvider } from "../../../support/fake-computer-provider";
import { chatRpc, createTestChat } from "../../../support/sdk";
import { testDatabaseUrl } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { postgres } from "../../../../core/server/database";

/** The RPC routes of a Bot-only SDK that spec 87's per-user limits cover, with the override that turns each on. */
const rpcCases = [
  {
    name: "credential save and check",
    route: "models/credentials/save",
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
    route: "bots/upload",
    rateLimits: { attachmentUpload: { limit: 1, windowSeconds: 60 } },
  },
];

/** The Bot-only plugins and features that serve every route in `rpcCases`, with the Computer they need. */
const botOnly = () => ({
  computer: fakeComputerProvider().provider,
  features: [knowledge()],
});

/** An RPC call to `route`. The limit is checked before the body is read, so the body can be empty. */
const rpcCall = (route: string) =>
  new Request(`http://localhost/api/chat/rpc/${route}`, { method: "POST", body: "{}" });

describe.each(rpcCases)("$name rate limits", ({ route, rateLimits }) => {
  it("answers 429 with Retry-After once a user passes the limit, and another user is unaffected", async () => {
    const user = await insertUser();
    const other = await insertUser();
    const deps = createTestSdk(botOnly());
    const as = (caller: typeof user) => createTestChat({ user: caller, deps, rateLimits }).fetch;

    const first = await as(user)(rpcCall(route));
    const limited = await as(user)(rpcCall(route));
    const others = await as(other)(rpcCall(route));

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
    const fetch = createTestChat({ user, deps: createTestSdk(botOnly()), rateLimits: off }).fetch;

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      statuses.push((await fetch(rpcCall(route))).status);
    }

    expect(statuses.every((status) => status !== 429)).toBe(true);
  });
});

it("takes its limit from createHttpHandler's rateLimits override", async () => {
  const user = await insertUser();
  const chat = createBotSdk({
    database: postgres({ connectionString: testDatabaseUrl }),
    keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
    pubsub: memoryRuntime(),
    models: {},
  });
  const http = createHttpHandler(chat, {
    basePath: "/api/chat",
    getUser: () => ({ id: user.id }),
    rateLimits: { credentialSave: { limit: 1, windowSeconds: 60 } },
  });

  const first = await http(rpcCall("models/credentials/save"));
  const second = await http(rpcCall("models/credentials/save"));

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
    rateLimits: { attachmentUpload: { limit: 0, windowSeconds: 60 } },
  });

  const caught = await client.bots
    .upload({ file: new File(["hi"], "a.txt", { type: "text/plain" }) })
    .catch((error: unknown) => error);

  expect(caught).toBeInstanceOf(RateLimitedError);
  expect((caught as RateLimitedError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
});
