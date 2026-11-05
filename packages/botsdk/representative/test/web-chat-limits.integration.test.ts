import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import type { CounterStore } from "@botsdk/bot/chat/counters";
import { toNodeHandler } from "@botsdk/bot/http";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createHttpHandlerOver } from "@botsdk/bot/over";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { answers, promoteAutoTopic } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";

import { representativeFeature, type RepresentativeOptions } from "../src/server/plugin";
import { webChatLimits } from "../src/server/web-chat-limits";

/*
 * Web chat's session and IP limits (ticket #1337): real HTTP requests over a Node server with a fake
 * Model, on real Postgres. The limits only call `CounterStore.hit`, so a counter store of the test's
 * own stands in for the Redis one, which passes the same contract.
 */

vi.setConfig({ testTimeout: 30_000 });

const basePath = "/api/chat";
const shop = "https://shop.example";
const model = "openai:gpt-6-luna";
const poll = { timeout: 10_000 };

const servers: Server[] = [];
const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A counter store of its own: fixed windows in a map, with no timers. */
function ownCounters(): CounterStore {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  return {
    async hit(key, windowMs) {
      const now = Date.now();
      let window = windows.get(key);
      if (!window || window.expiresAt <= now) {
        window = { count: 0, expiresAt: now + windowMs };
        windows.set(key, window);
      }
      window.count++;
      return { count: window.count, resetMs: window.expiresAt - now };
    },
  };
}

/** A served instance with an enabled Representative and a live key allowing `shop`. */
async function world(options: RepresentativeOptions = {}, counters?: CounterStore) {
  const timer = fakeJobClock(new Date("2026-11-05T12:00:00Z"));
  const fake = createFakeAdapter({ rounds: [answers(), round()] });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [representativeFeature(options)],
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    memory: false,
    ...(counters && { counters }),
  });
  await jobs.start();
  runners.push(jobs);
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

  /** A session start from `ip`, which the Host's `clientIp` reads from `x-test-ip`. */
  const start = (ip?: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/representative/widget/${key}/session`, {
      method: "POST",
      headers: { origin: shop, ...(ip && { "x-test-ip": ip }), ...headers },
    });
  const token = async (ip?: string) =>
    ((await (await start(ip)).json()) as { token: string }).token;
  const send = (sessionToken: string, ip?: string) =>
    fetch(`${url}/representative/widget/send`, {
      method: "POST",
      headers: {
        origin: shop,
        "content-type": "text/plain;charset=UTF-8",
        ...(ip && { "x-test-ip": ip }),
      },
      body: JSON.stringify({ token: sessionToken, text: "Hello" }),
    });
  const stream = (sessionToken: string, ip: string) =>
    fetch(`${url}/representative/widget/stream`, {
      method: "POST",
      headers: { origin: shop, "content-type": "text/plain;charset=UTF-8", "x-test-ip": ip },
      body: JSON.stringify({ token: sessionToken }),
    });
  const turnsRun = () => {
    timer.advance(batchLongestMs);
    timer.tick();
  };
  return { fake, start, token, send, stream, turnsRun };
}

const byHeader = (request: Request) => request.headers.get("x-test-ip");

describe("web chat limits", () => {
  it("refuses a send over the session's limit, with Retry-After and no model call", async () => {
    const { token, send, turnsRun, fake } = await world({ clientIp: byHeader });
    const session = await token("1.1.1.1");
    for (let sent = 0; sent < webChatLimits.sendsPerSession.limit; sent += 1) {
      expect((await send(session, "1.1.1.1")).status).toBe(202);
    }
    turnsRun();
    // The accepted messages batch into one Turn, whose model calls are all there are.
    await expect.poll(() => fake.calls.length, poll).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const calls = fake.calls.length;

    const over = await send(session, "1.1.1.1");
    turnsRun();

    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(over.headers.get("access-control-expose-headers")).toBe("Retry-After");
    expect(await over.json()).toEqual({ code: "error.tooManyRequests", params: {} });
    // Nothing was stored for the refused message, so nothing was due and no Turn ran.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fake.calls.length).toBe(calls);
  });

  it("limits a session even when the Host gave no clientIp", async () => {
    const { token, send } = await world();
    const session = await token();
    for (let sent = 0; sent < webChatLimits.sendsPerSession.limit; sent += 1) {
      await send(session);
    }
    expect((await send(session)).status).toBe(429);
  });

  it("refuses session starts over the IP's limit, and not another IP's", async () => {
    const { start } = await world({ clientIp: byHeader });
    for (let started = 0; started < webChatLimits.sessionStartsPerIp.limit; started += 1) {
      expect((await start("2.2.2.2")).status).toBe(200);
    }
    const over = await start("2.2.2.2");

    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await start("3.3.3.3")).status).toBe(200);
  });

  it("refuses sends over the IP's limit across different sessions", async () => {
    const { token, send } = await world({ clientIp: byHeader });
    // One session per send, so only the IP's count can refuse.
    const perIp = webChatLimits.sendsPerIp.limit;
    const statuses: number[] = [];
    for (let sent = 0; sent <= perIp; sent += 1) {
      statuses.push((await send(await token(`4.${sent}.0.0`), "5.5.5.5")).status);
    }

    expect(statuses.slice(0, perIp).every((status) => status === 202)).toBe(true);
    expect(statuses[perIp]).toBe(429);
    expect((await send(await token(), "6.6.6.6")).status).toBe(202);
  });

  it("refuses stream openings over the IP's limit, before reading any session", async () => {
    const { stream } = await world({ clientIp: byHeader });
    const perIp = webChatLimits.streamOpensPerIp.limit;
    for (let opened = 0; opened < perIp; opened += 1) {
      // A token that opens nothing: what counts is the opening.
      expect((await stream("no session", "7.7.7.7")).status).toBe(401);
    }

    const refused = await stream("no session", "7.7.7.7");

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("access-control-expose-headers")).toBe("Retry-After");
    expect((await stream("no session", "8.8.8.8")).status).toBe(401);
  });

  it("counts the IP the Host reads, not a forged forwarded header", async () => {
    const { start } = await world({ clientIp: byHeader });
    for (let started = 0; started < webChatLimits.sessionStartsPerIp.limit; started += 1) {
      // Every request claims a new address in the headers a proxy would set.
      await start("7.7.7.7", {
        "x-forwarded-for": `9.9.9.${started}`,
        "x-real-ip": `8.8.8.${started}`,
      });
    }

    expect((await start("7.7.7.7", { "x-forwarded-for": "9.9.9.200" })).status).toBe(429);
  });

  it("reads no forwarded header when the Host gave no clientIp", async () => {
    const { start } = await world();
    // With no IP to count, no number of starts is limited, whatever the headers say.
    for (let started = 0; started <= webChatLimits.sessionStartsPerIp.limit; started += 1) {
      expect((await start(undefined, { "x-forwarded-for": "9.9.9.9" })).status).toBe(200);
    }
  });

  it("holds the same limits on another counter store", async () => {
    const { token, send } = await world({ clientIp: byHeader }, ownCounters());
    const session = await token("1.1.1.1");
    for (let sent = 0; sent < webChatLimits.sendsPerSession.limit; sent += 1) {
      await send(session, "1.1.1.1");
    }

    expect((await send(session, "1.1.1.1")).status).toBe(429);
  });
});
