import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { toNodeHandler } from "@botsdk/bot/http";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createHttpHandlerOver } from "@botsdk/bot/over";
import { redisRuntime } from "@botsdk/pubsub-redis";
import { representative } from "@botsdk/representative";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { promoteAutoTopic } from "@ai-chat/test-support/test-customer";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter } from "@botsdk/testing/fake-adapter";

/*
 * Web chat's limits on the real Redis counters (ticket #1337). They sit here because this is where
 * `@botsdk/representative` and `@botsdk/pubsub-redis` are both dependencies. Set `TEST_REDIS_URL` (for
 * example `redis://127.0.0.1:6380/8`); without it they are skipped. Each run counts under its own IPs
 * and session, so no key from an earlier run is hit, and a key expires with its window.
 */

vi.setConfig({ testTimeout: 30_000 });

const redisUrl = process.env.TEST_REDIS_URL;
const basePath = "/api/chat";
const shop = "https://shop.example";
const model = "openai:gpt-6-luna";

// The Representative's limits: 10 session starts per IP, 10 sends per session, 30 sends per IP.
const startsPerIp = 10;
const sendsPerSession = 10;
const sendsPerIp = 30;

const servers: Server[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function world() {
  const runtime = redisRuntime({ url: redisUrl!, prefix: "ai-chat-1337:" });
  closers.push(() => runtime.close!());
  const fake = createFakeAdapter({ rounds: [] });
  const deps = createTestSdk({
    runtime,
    features: [representative({ clientIp: (request) => request.headers.get("x-test-ip") })],
    adapterFor: () => fake.adapter,
    memory: false,
  });
  const user = await insertUser();
  const server = createServer(
    toNodeHandler(createHttpHandlerOver(deps, { basePath, getUser: () => null })),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${basePath}`;
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  await promoteAutoTopic(id);
  await rpc.representative.widgetKeyCreate({ id });
  const { key } = await rpc.representative.widgetKeySetOrigins({ id, origins: [shop] });
  const start = (ip: string) =>
    fetch(`${url}/representative/widget/${key}/session`, {
      method: "POST",
      headers: { origin: shop, "x-test-ip": ip },
    });
  const send = (token: string, ip: string) =>
    fetch(`${url}/representative/widget/send`, {
      method: "POST",
      headers: { origin: shop, "content-type": "text/plain;charset=UTF-8", "x-test-ip": ip },
      body: JSON.stringify({ token, text: "Hello" }),
    });
  const token = async (ip: string) => ((await (await start(ip)).json()) as { token: string }).token;
  return { start, send, token };
}

/** An IP no earlier run counted under. */
const freshIp = () => `ip-${randomUUID()}`;

/** The seconds a refusal says to wait, which a Redis window of at most its length must keep. */
function expectUsableRetryAfter(response: Response, windowSeconds: number) {
  const seconds = Number(response.headers.get("retry-after"));
  expect(Number.isInteger(seconds)).toBe(true);
  expect(seconds).toBeGreaterThan(0);
  expect(seconds).toBeLessThanOrEqual(windowSeconds);
}

describe.skipIf(!redisUrl)("web chat limits on the Redis counters", () => {
  it("refuses a session start over the IP's limit, with a usable Retry-After", async () => {
    const { start } = await world();
    const ip = freshIp();
    for (let started = 0; started < startsPerIp; started += 1) {
      expect((await start(ip)).status).toBe(200);
    }

    const over = await start(ip);

    expect(over.status).toBe(429);
    expectUsableRetryAfter(over, 600);
    expect((await start(freshIp())).status).toBe(200);
  });

  it("refuses a send over the session's limit, with a usable Retry-After", async () => {
    const { token, send } = await world();
    const ip = freshIp();
    const session = await token(ip);
    for (let sent = 0; sent < sendsPerSession; sent += 1) {
      expect((await send(session, ip)).status).toBe(202);
    }

    const over = await send(session, ip);

    expect(over.status).toBe(429);
    expectUsableRetryAfter(over, 60);
  });

  it("refuses sends over the IP's limit across sessions", async () => {
    const { token, send } = await world();
    const ip = freshIp();
    for (let sent = 0; sent < sendsPerIp; sent += 1) {
      expect((await send(await token(freshIp()), ip)).status).toBe(202);
    }

    const over = await send(await token(freshIp()), ip);

    expect(over.status).toBe(429);
    expectUsableRetryAfter(over, 60);
  });
});
