import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toNodeHandler } from "@botsdk/bot/http";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createHttpHandlerOver } from "@botsdk/bot/over";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { deleteUserData, exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { answers, testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { testKeyEncryptionSecret } from "@botsdk/testing/test-sdk";

import { representativeCustomerIdentity, representativeWidgetKey } from "../src/server/db/schema";
import { representativeFeature } from "../src/server/plugin";
import { readWidgetSession } from "../src/server/widget-key";

/*
 * A Representative's widget key and web chat session start (ticket #1333): real HTTP requests to the
 * public route, over a Node server, on real Postgres, with a clock the test moves.
 */

vi.setConfig({ testTimeout: 30_000 });

const basePath = "/api/chat";
const shop = "https://shop.example";
const hour = 60 * 60_000;
const model = "openai:gpt-6-luna";

const servers: Server[] = [];
const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * A served instance with a running runner and a fake Model: its URL, and the clock the test moves.
 * `rounds` is what the Model says, for a test that runs Turns.
 */
async function serve({
  secrets,
  rounds = [],
}: {
  secrets?: string[];
  rounds?: Parameters<typeof createFakeAdapter>[0]["rounds"];
} = {}) {
  const timer = fakeJobClock(new Date("2026-11-05T12:00:00Z"));
  const fake = createFakeAdapter({ rounds });
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
    features: [representativeFeature()],
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    memory: false,
    ...(secrets && { keyEncryptionSecrets: secrets }),
  });
  await jobs.start();
  runners.push(jobs);
  const server = createServer(
    toNodeHandler(createHttpHandlerOver(deps, { basePath, getUser: () => null })),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${basePath}`;
  return { deps: Object.assign(deps, { timer }), timer, url };
}

type Timer = ReturnType<typeof fakeJobClock>;

/** A new owner with a Representative, and its live key allowing `shop`. */
async function ownerWithKey(deps: TestDeps) {
  const user = await insertUser();
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.widgetKeyCreate({ id });
  const { key } = await rpc.representative.widgetKeySetOrigins({ id, origins: [shop] });
  return { user, rpc, id, key };
}

/** Starts a session as a browser on `origin` would: a bare POST, with no body. */
const start = (url: string, key: string, origin: string | null = shop) =>
  fetch(`${url}/representative/widget/${key}/session`, {
    method: "POST",
    headers: origin === null ? {} : { origin },
  });

const started = async (url: string, key: string) => {
  const response = await start(url, key);
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; expiresAt: string };
};

const servicesOf = (timer: Timer, secrets = [testKeyEncryptionSecret]) => ({
  db: getTestDb(),
  keyring: secrets,
  clock: timer.clock.now,
});

describe("the owner's widget key", () => {
  it("is created, edited, rotated and disabled, and starts with no origins allowed", async () => {
    const { deps } = await serve();
    const rpc = chatRpc({ user: await insertUser(), deps });
    const { id } = await rpc.representative.create({ name: "Front desk" });
    expect(await rpc.representative.widgetKeyGet({ id })).toBeNull();

    const created = await rpc.representative.widgetKeyCreate({ id });
    expect(created).toEqual({ key: expect.any(String), allowedOrigins: [], status: "live" });
    expect(await rpc.representative.widgetKeyGet({ id })).toEqual(created);

    const edited = await rpc.representative.widgetKeySetOrigins({
      id,
      origins: ["https://Shop.Example/", shop, "http://localhost:3000"],
    });
    expect(edited.allowedOrigins).toEqual([shop, "http://localhost:3000"]);
    expect(edited.key).toBe(created.key);

    const disabled = await rpc.representative.widgetKeyDisable({ id });
    expect(disabled.status).toBe("disabled");
    expect(disabled.key).toBe(created.key);

    const rotated = await rpc.representative.widgetKeyRotate({ id });
    expect(rotated.status).toBe("live");
    expect(rotated.key).not.toBe(created.key);
    expect(rotated.allowedOrigins).toEqual(edited.allowedOrigins);
    expect(await rpc.representative.widgetKeyGet({ id })).toEqual(rotated);
  });

  it("refuses a second key, and changing one that doesn't exist", async () => {
    const { deps } = await serve();
    const rpc = chatRpc({ user: await insertUser(), deps });
    const { id } = await rpc.representative.create({ name: "Front desk" });
    const missing = { data: { code: "error.widgetKeyNotFound" } };

    await expect(rpc.representative.widgetKeyRotate({ id })).rejects.toMatchObject(missing);
    await expect(rpc.representative.widgetKeyDisable({ id })).rejects.toMatchObject(missing);
    await expect(
      rpc.representative.widgetKeySetOrigins({ id, origins: [shop] }),
    ).rejects.toMatchObject(missing);

    await rpc.representative.widgetKeyCreate({ id });
    await expect(rpc.representative.widgetKeyCreate({ id })).rejects.toMatchObject({
      data: { code: "error.widgetKeyTaken" },
    });
  });

  it.each([
    "shop.example",
    "https://shop.example/page",
    "https://shop.example?a=1",
    "https://*.example",
    "ftp://shop.example",
    "https://user@shop.example",
    "null",
  ])("refuses %s as an origin", async (origin) => {
    const { deps } = await serve();
    const { rpc, id } = await ownerWithKey(deps);
    await expect(
      rpc.representative.widgetKeySetOrigins({ id, origins: [origin] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await rpc.representative.widgetKeyGet({ id }))?.allowedOrigins).toEqual([shop]);
  });

  it("is only its owner's to manage, the same as a Representative that doesn't exist", async () => {
    const { deps } = await serve();
    const { id, key } = await ownerWithKey(deps);
    const other = chatRpc({ user: await insertUser(), deps }).representative;

    const calls = [
      () => other.widgetKeyGet({ id }),
      () => other.widgetKeyCreate({ id }),
      () => other.widgetKeySetOrigins({ id, origins: ["https://evil.example"] }),
      () => other.widgetKeyRotate({ id }),
      () => other.widgetKeyDisable({ id }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        data: { code: "error.representativeNotFound" },
      });
    }
    const [row] = await getTestDb()
      .select()
      .from(representativeWidgetKey)
      .where(eq(representativeWidgetKey.representativeId, id));
    expect(row).toMatchObject({ key, allowedOrigins: [shop], status: "live" });
  });

  it("goes with its owner's data, and is in their export", async () => {
    const { deps } = await serve();
    const { user, id, key } = await ownerWithKey(deps);

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: { representatives: Array<{ widgetKey: unknown }> };
    };
    expect(exported.representative.representatives[0]?.widgetKey).toEqual({
      key,
      allowedOrigins: [shop],
      status: "live",
    });

    await deleteUserData(deps, user.id);
    expect(
      await getTestDb()
        .select()
        .from(representativeWidgetKey)
        .where(eq(representativeWidgetKey.representativeId, id)),
    ).toEqual([]);
  });
});

describe("starting a web chat session", () => {
  it("issues a 24-hour token to an allowed origin on a live key, readable by that origin", async () => {
    const { deps, timer, url } = await serve();
    const { id, key } = await ownerWithKey(deps);

    const response = await start(url, key);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(shop);
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { token, expiresAt } = (await response.json()) as { token: string; expiresAt: string };
    expect(expiresAt).toBe("2026-11-06T12:00:00.000Z");
    expect(await readWidgetSession(servicesOf(timer), token)).toEqual({
      representativeId: id,
      heard: { channel: "web", externalId: expect.any(String) },
      expiresAt: new Date(expiresAt),
    });
  });

  it("refuses a wrong origin, and no origin, the same as a key that doesn't exist", async () => {
    const { deps, url } = await serve();
    const { key } = await ownerWithKey(deps);

    const unknown = await start(url, "no-such-key");
    expect(unknown.status).toBe(403);
    const body = await unknown.json();
    for (const origin of ["https://evil.example", "http://shop.example", "null", null]) {
      const refused = await start(url, key, origin);
      expect(refused.status).toBe(403);
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
      expect(await refused.json()).toEqual(body);
    }
  });

  it("refuses every origin until the owner lists one, and one taken off the list", async () => {
    const { deps, url } = await serve();
    const rpc = chatRpc({ user: await insertUser(), deps });
    const { id } = await rpc.representative.create({ name: "Front desk" });
    const { key } = await rpc.representative.widgetKeyCreate({ id });
    expect((await start(url, key)).status).toBe(403);

    await rpc.representative.widgetKeySetOrigins({ id, origins: [shop] });
    expect((await start(url, key)).status).toBe(200);

    await rpc.representative.widgetKeySetOrigins({ id, origins: [] });
    expect((await start(url, key)).status).toBe(403);
  });

  it("refuses a rotated key, and serves the new one", async () => {
    const { deps, url } = await serve();
    const { rpc, id, key } = await ownerWithKey(deps);

    const rotated = await rpc.representative.widgetKeyRotate({ id });

    expect((await start(url, key)).status).toBe(403);
    expect((await start(url, rotated.key)).status).toBe(200);
  });

  it("refuses a disabled key, until rotating gives a new one", async () => {
    const { deps, url } = await serve();
    const { rpc, id, key } = await ownerWithKey(deps);

    await rpc.representative.widgetKeyDisable({ id });
    expect((await start(url, key)).status).toBe(403);

    const rotated = await rpc.representative.widgetKeyRotate({ id });
    expect((await start(url, key)).status).toBe(403);
    expect((await start(url, rotated.key)).status).toBe(200);
  });

  it("makes each start a new identity, and each one unverified, even with the same browser", async () => {
    const { deps, timer, url } = await serve({
      rounds: [answers(), round(), answers(), round()],
    });
    const { user, rpc, id, key } = await ownerWithKey(deps);
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    await rpc.representative.updateDraft({
      id,
      draft: { jobText: "Answer questions.", model },
    });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });

    const heard = [];
    for (const _ of [1, 2]) {
      const { token } = await started(url, key);
      const session = await readWidgetSession(servicesOf(timer), token);
      heard.push(session!.heard);
      await testCustomerTurn(deps, {
        representativeId: id,
        channel: session!.heard.channel,
        externalId: session!.heard.externalId,
        message: "Hello",
      });
    }

    expect(heard[0]!.externalId).not.toBe(heard[1]!.externalId);
    const identities = await getTestDb()
      .select()
      .from(representativeCustomerIdentity)
      .where(
        and(
          eq(representativeCustomerIdentity.userId, user.id),
          eq(representativeCustomerIdentity.channel, "web"),
        ),
      );
    expect(identities.map((identity) => identity.externalId).sort()).toEqual(
      heard.map((each) => each.externalId).sort(),
    );
    expect(new Set(identities.map((identity) => identity.customerId)).size).toBe(2);
    for (const identity of identities) {
      expect(identity.verifiedContactAt).toBeNull();
      expect(identity.provenUntil).toBeNull();
    }
  });

  it("makes no row for an identity until the visitor writes", async () => {
    const { deps, url } = await serve();
    const { user, key } = await ownerWithKey(deps);
    await started(url, key);
    expect(
      await getTestDb()
        .select()
        .from(representativeCustomerIdentity)
        .where(eq(representativeCustomerIdentity.userId, user.id)),
    ).toEqual([]);
  });
});

describe("reading a session token", () => {
  const session = async () => {
    const served = await serve();
    const owner = await ownerWithKey(served.deps);
    const { token } = await started(served.url, owner.key);
    const read = (value: string) => readWidgetSession(servicesOf(served.timer), value);
    expect(await read(token)).not.toBeNull();
    return { ...served, ...owner, token, read };
  };

  it("refuses a tampered token, whichever part changed", async () => {
    const { token, read } = await session();
    const parts = token.split(".");
    expect(parts).toHaveLength(4);
    for (const index of parts.keys()) {
      const changed = parts.map((part, at) =>
        at === index ? `${part.slice(0, -1)}${part.endsWith("A") ? "B" : "A"}` : part,
      );
      expect(await read(changed.join("."))).toBeNull();
    }
    for (const bad of ["", "a.b", `${token}.extra`, "....", "é.é.é.é"]) {
      expect(await read(bad)).toBeNull();
    }
  });

  it("refuses a later expiry written into a token", async () => {
    const { token, read, timer } = await session();
    const [key, identity, expires, signature] = token.split(".");
    const later = Number(expires) + 365 * 24 * hour;
    timer.advance(25 * hour);
    expect(await read(`${key}.${identity}.${later}.${signature}`)).toBeNull();
  });

  it("reads a token for 24 hours and refuses it after", async () => {
    const { token, read, timer } = await session();
    timer.advance(24 * hour - 1);
    expect(await read(token)).not.toBeNull();
    timer.advance(1);
    expect(await read(token)).toBeNull();
  });

  it("refuses a token from a rotated key", async () => {
    const { rpc, id, token, read } = await session();
    await rpc.representative.widgetKeyRotate({ id });
    expect(await read(token)).toBeNull();
  });

  it("refuses a token from a disabled key, and rotating doesn't bring it back", async () => {
    const { rpc, id, token, read } = await session();
    await rpc.representative.widgetKeyDisable({ id });
    expect(await read(token)).toBeNull();
    await rpc.representative.widgetKeyRotate({ id });
    expect(await read(token)).toBeNull();
  });

  it("goes on reading a running session when its origin comes off the list", async () => {
    const { rpc, id, token, read } = await session();
    await rpc.representative.widgetKeySetOrigins({ id, origins: [] });
    expect(await read(token)).not.toBeNull();
  });

  it("reads a token signed under an older secret of the keyring, and not one outside it", async () => {
    const older = "an-older-key-encryption-secret-for-this-test";
    const newer = "a-newer-secret-at-the-front-of-the-keyring";
    const { deps, timer, url } = await serve({ secrets: [older] });
    const { key } = await ownerWithKey(deps);
    const { token } = await started(url, key);

    const read = (secrets: string[]) => readWidgetSession(servicesOf(timer, secrets), token);

    expect(await read([newer, older])).not.toBeNull();
    expect(await read([newer])).toBeNull();
  });
});
