import { describe, expect, it } from "vitest";

import { createChat } from "../../../../core/server/create-chat";
import { memoryRuntime } from "../../../../core/server/runtime";
import { resolveRateLimits, type RateLimits } from "../../../../core/server/rate-limits";
import { RateLimitedError } from "../../../../core/client/rate-limit";
import { chatRpc, sendAs } from "../../../support/sdk";
import { createTestDeps } from "../../../support/deps";
import { testDatabaseUrl } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import type { TestUser } from "../../../support/users";

const runUrl = "http://localhost/api/chat/run";

/**
 * A Run start that the limit counts. The body is not a valid command, so the handler refuses it
 * with 400 after the limit check, and no Conversation or Provider is touched.
 */
const runStart = (user: TestUser | null) =>
  user
    ? new Request(runUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [], forwardedProps: {} }),
      })
    : null;

describe("Run start rate limits", () => {
  it("answers 429 with Retry-After once a user passes the limit, and another user is unaffected", async () => {
    const user = await insertUser();
    const other = await insertUser();
    const deps = createTestDeps({
      rateLimits: resolveRateLimits({ runStart: { limit: 2, windowSeconds: 60 } }),
    });

    const first = await sendAs(runStart(user)!, user, deps);
    const second = await sendAs(runStart(user)!, user, deps);
    const limited = await sendAs(runStart(user)!, user, deps);
    const others = await sendAs(runStart(other)!, other, deps);

    expect([first.status, second.status]).toEqual([400, 400]);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(others.status).toBe(400);
  });

  it("allows 20 Run starts a minute by default, then refuses the 21st", async () => {
    const user = await insertUser();
    const deps = createTestDeps();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      statuses.push((await sendAs(runStart(user)!, user, deps)).status);
    }

    expect(statuses.slice(0, 20).every((status) => status === 400)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it("takes its limit from createChat's rateLimits override", async () => {
    const user = await insertUser();
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => ({ id: user.id }),
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath: "/api/chat",
      runtime: memoryRuntime(),
      rateLimits: { runStart: { limit: 1, windowSeconds: 60 } },
    });

    const first = await chat.handler(runStart(user)!);
    const second = await chat.handler(runStart(user)!);

    expect(first.status).toBe(400);
    expect(second.status).toBe(429);
  });

  it("never refuses a Run start when its limit is turned off with false", async () => {
    const user = await insertUser();
    const deps = createTestDeps({ rateLimits: resolveRateLimits({ runStart: false }) });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt++) {
      statuses.push((await sendAs(runStart(user)!, user, deps)).status);
    }

    expect(statuses.every((status) => status === 400)).toBe(true);
  });
});

/** The RPC routes that spec 87's per-user limits cover, with the override that turns each on. */
const rpcCases = [
  {
    name: "attachment upload",
    route: "attachment/upload",
    rateLimits: { attachmentUpload: { limit: 1, windowSeconds: 60 } },
  },
  {
    name: "credential save and check",
    route: "credentials/save",
    rateLimits: { credentialSave: { limit: 1, windowSeconds: 60 } },
  },
  {
    name: "Conversation search",
    route: "search/query",
    rateLimits: { conversationSearch: { limit: 1, windowSeconds: 60 } },
  },
];

/** An RPC call to `route`. The limit is checked before the body is read, so the body can be empty. */
const rpcCall = (route: string) =>
  new Request(`http://localhost/api/chat/rpc/${route}`, { method: "POST", body: "{}" });

describe.each(rpcCases)("$name rate limits", ({ route, rateLimits }) => {
  it("answers 429 with Retry-After once a user passes the limit, and another user is unaffected", async () => {
    const user = await insertUser();
    const other = await insertUser();
    const deps = createTestDeps({ rateLimits: resolveRateLimits(rateLimits) });

    const first = await sendAs(rpcCall(route), user, deps);
    const limited = await sendAs(rpcCall(route), user, deps);
    const others = await sendAs(rpcCall(route), other, deps);

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
    const deps = createTestDeps({ rateLimits: resolveRateLimits(off) });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      statuses.push((await sendAs(rpcCall(route), user, deps)).status);
    }

    expect(statuses.every((status) => status !== 429)).toBe(true);
  });
});

it("defaults to spec 87's numbers: 30 uploads per 10 minutes, 10 saves a minute, 60 searches a minute", () => {
  expect(resolveRateLimits()).toMatchObject({
    attachmentUpload: { limit: 30, windowSeconds: 600 },
    credentialSave: { limit: 10, windowSeconds: 60 },
    conversationSearch: { limit: 60, windowSeconds: 60 },
  });
});

it("surfaces the limit to the typed client as a RateLimitedError with the retry time", async () => {
  const user = await insertUser();
  const client = chatRpc({
    user,
    deps: createTestDeps({
      rateLimits: resolveRateLimits({ attachmentUpload: { limit: 0, windowSeconds: 60 } }),
    }),
  });

  const caught = await client.attachment
    .upload({ file: new File(["hi"], "a.txt", { type: "text/plain" }) })
    .catch((error: unknown) => error);

  expect(caught).toBeInstanceOf(RateLimitedError);
  expect((caught as RateLimitedError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
});

describe("Shared link view rate limits, per client IP", () => {
  /** A Shared link read from `ip`, as the client sends it: the empty body is never read, since the limit comes first. */
  const sharedRead = (ip: string) =>
    new Request("http://localhost/api/chat/rpc/share/get", {
      method: "POST",
      headers: { "x-test-ip": ip },
      body: "{}",
    });

  const chatWith = (options: { rateLimits?: RateLimits; withIp?: boolean }) =>
    createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath: "/api/chat",
      runtime: memoryRuntime(),
      rateLimits: options.rateLimits,
      getClientIp:
        options.withIp === false ? undefined : (request) => request.headers.get("x-test-ip"),
    });

  it("answers 429 with Retry-After for the IP over its limit, and another IP is unaffected", async () => {
    const chat = chatWith({ rateLimits: { sharedLinkView: { limit: 1, windowSeconds: 60 } } });

    const first = await chat.handler(sharedRead("203.0.113.1"));
    const limited = await chat.handler(sharedRead("203.0.113.1"));
    const other = await chat.handler(sharedRead("203.0.113.2"));

    expect(first.status).not.toBe(429);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(other.status).not.toBe(429);
  });

  it("is not limited without getClientIp, since there is no IP to count", async () => {
    const chat = chatWith({
      rateLimits: { sharedLinkView: { limit: 0, windowSeconds: 60 } },
      withIp: false,
    });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      statuses.push((await chat.handler(sharedRead("203.0.113.1"))).status);
    }

    expect(statuses.every((status) => status !== 429)).toBe(true);
  });

  it("never refuses when its limit is turned off with false", async () => {
    const chat = chatWith({ rateLimits: { sharedLinkView: false } });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      statuses.push((await chat.handler(sharedRead("203.0.113.1"))).status);
    }

    expect(statuses.every((status) => status !== 429)).toBe(true);
  });

  it("does not limit the server-side getSharedConversation, which is the Host's own page", async () => {
    const chat = chatWith({ rateLimits: { sharedLinkView: { limit: 0, windowSeconds: 60 } } });

    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await chat.getSharedConversation("no-such-token")).toBeNull();
    }
  });

  it("defaults to 60 views a minute per IP", () => {
    expect(resolveRateLimits().sharedLinkView).toEqual({ limit: 60, windowSeconds: 60 });
  });
});
