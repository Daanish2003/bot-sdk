import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createHookEmitter, type UsageEvent } from "../../../../core/server/chat/hooks";
import {
  freeMeter,
  freeModelMeter,
  hostModelMeter,
  hostSearchMeter,
  imageMeter,
} from "../../../../plugins/models/server/internal";
import { createTestSdk } from "../../../support/deps";
import { usage } from "../../../../core/server/storage";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const sonnet = "anthropic:claude-sonnet-5-5";
// $3 per 1M input tokens and $15 per 1M output tokens, so a token costs as many micros as its price.
const price = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
const usageOf = {
  input: 100,
  output: 20,
  reasoning: 0,
  cached: 0,
  cacheWrite: 0,
  estimated: false,
};

async function rowsOf(userId: string) {
  return getTestDb().select().from(usage).where(eq(usage.userId, userId));
}

/** Deps whose `onUsage` hook collects every usage event, and a $1-a-day Quota. */
function depsWithHook(overrides: Parameters<typeof createTestSdk>[0] = {}) {
  const events: UsageEvent[] = [];
  const deps = createTestSdk({
    getQuota: async () => ({ budgetUsd: 1, window: "day" }),
    hooks: createHookEmitter({ onUsage: (event) => void events.push(event) }, { error: () => {} }),
    ...overrides,
  });
  return { deps, events };
}

describe("the free meter", () => {
  it("always lets a call run and records nothing", async () => {
    await expect(freeMeter.mayRun()).resolves.toEqual({ ok: true });
    await expect(freeMeter.record({})).resolves.toBeUndefined();
    expect(freeMeter.onHost).toBe(false);
  });
});

describe("the free meter of a Model call", () => {
  it("records the call at cost 0 and never refuses it, so a Quota's spend is unchanged", async () => {
    const user = await insertUser();
    const { deps, events } = depsWithHook({
      getQuota: async () => ({ budgetUsd: 0, window: "day" }),
    });
    const meter = freeModelMeter(deps, user.id, sonnet);
    const cachedCall = { ...usageOf, input: 1000, cached: 600, cacheWrite: 200 };

    await meter.record({ kind: "turn", usage: cachedCall, sourceId: "turn-1" });

    expect(meter.onHost).toBe(false);
    await expect(meter.mayRun()).resolves.toEqual({ ok: true });
    const [row] = await rowsOf(user.id);
    expect(row).toMatchObject({
      kind: "turn",
      model: sonnet,
      inputTokens: 1000,
      cacheReadTokens: 600,
      cacheWriteTokens: 200,
      sourceId: "turn-1",
      costMicros: 0,
    });
    await vi.waitFor(() => expect(events).toEqual([expect.objectContaining({ id: row!.id })]));
  });
});

describe("a Host meter", () => {
  it("prices a Model call, writes its usage row and fires onUsage", async () => {
    const user = await insertUser();
    const { deps, events } = depsWithHook();
    const meter = hostModelMeter(deps, user.id, sonnet, price);

    await meter.record({ kind: "title", usage: usageOf });

    const [row] = await rowsOf(user.id);
    expect(row).toMatchObject({
      kind: "title",
      model: sonnet,
      inputTokens: 100,
      outputTokens: 20,
      costMicros: 100 * 3 + 20 * 15,
      estimated: false,
    });
    await vi.waitFor(() => expect(events).toEqual([expect.objectContaining({ id: row!.id })]));
  });

  it("prices cache reads and writes at the Model's cache prices, and keeps the split and the source", async () => {
    const user = await insertUser();
    const meter = hostModelMeter(createTestSdk(), user.id, sonnet, {
      ...price,
      cacheReadUsdPerMillion: 0.3,
      cacheWriteUsdPerMillion: 6,
    });
    const cachedCall = { ...usageOf, input: 1000, cached: 600, cacheWrite: 200 };

    await meter.record({ kind: "turn", usage: cachedCall, sourceId: "turn-1" });

    expect((await rowsOf(user.id))[0]).toMatchObject({
      kind: "turn",
      inputTokens: 1000,
      cacheReadTokens: 600,
      cacheWriteTokens: 200,
      sourceId: "turn-1",
      // 200 uncached at $3, 600 read at $0.30, 200 written at $6, 20 out at $15.
      costMicros: 600 + 180 + 1200 + 300,
    });
  });

  it("prices cached tokens at the input rate when the Model has no cache prices", async () => {
    const user = await insertUser();
    const meter = hostModelMeter(createTestSdk(), user.id, sonnet, price);
    const cachedCall = { ...usageOf, input: 1000, cached: 600, cacheWrite: 200 };

    await meter.record({ kind: "helper", usage: cachedCall, sourceId: "helper-1" });

    expect((await rowsOf(user.id))[0]).toMatchObject({
      cacheReadTokens: 600,
      cacheWriteTokens: 200,
      sourceId: "helper-1",
      costMicros: 1000 * 3 + 20 * 15,
    });
  });

  it("prices usage recorded before cache writes were kept as writing none", async () => {
    const user = await insertUser();
    const meter = hostModelMeter(createTestSdk(), user.id, sonnet, price);
    const { cacheWrite: _absent, ...recordedBefore } = usageOf;

    await meter.record({ kind: "turn", usage: recordedBefore });

    expect((await rowsOf(user.id))[0]).toMatchObject({
      cacheWriteTokens: 0,
      costMicros: 100 * 3 + 20 * 15,
    });
  });

  it("takes the Provider's reported cost over the token price", async () => {
    const user = await insertUser();
    const meter = hostModelMeter(createTestSdk(), user.id, sonnet, price);

    await meter.record({ kind: "run", usage: usageOf, reportedCost: 0.25 });

    expect((await rowsOf(user.id))[0]?.costMicros).toBe(250_000);
  });

  it("refuses a call once the window's spend reaches the budget, until the window resets", async () => {
    const user = await insertUser();
    const { deps } = depsWithHook();
    const meter = hostSearchMeter(deps, user.id, 0.5);
    await expect(meter.mayRun()).resolves.toEqual({ ok: true });

    await meter.record();
    await meter.record();

    const check = await meter.mayRun();
    expect(check.ok).toBe(false);
    expect(!check.ok && check.resetsAt.getTime()).toBeGreaterThan(Date.now());
    expect((await rowsOf(user.id)).map((row) => row.costMicros)).toEqual([500_000, 500_000]);
  });

  it("sends a failed usage write to the logger and doesn't throw", async () => {
    const user = await insertUser();
    const error = vi.fn();
    const db = getTestDb();
    const failing = new Proxy(db, {
      get: (target, key) =>
        key === "insert"
          ? () => ({ values: () => Promise.reject(new Error("usage write failed")) })
          : Reflect.get(target, key, target),
    });
    const { deps, events } = depsWithHook({ db: failing, logger: { error } });

    await expect(hostSearchMeter(deps, user.id, 0.01).record()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^Recording usage of a web_search/),
      expect.any(Error),
    );
    expect(events).toEqual([]);
  });
});

describe("an image meter", () => {
  const imagePrice = { pricePerImageUsd: 0.04 };
  const kept = { reached: true, answered: true, stored: true, stopped: false };

  it("records an image on the user's own key with no Host cost, and never refuses it", async () => {
    const user = await insertUser();
    const { deps } = depsWithHook();
    const meter = imageMeter(deps, user.id, { model: "openai:gpt-image-1", provider: "openai" });

    await meter.record(kept);

    expect(meter.onHost).toBe(false);
    await expect(meter.mayRun()).resolves.toEqual({ ok: true });
    expect((await rowsOf(user.id))[0]).toMatchObject({ kind: "image", costMicros: 0 });
  });

  it("bills a Stop on an adapter that runs on at the flat price, and an unanswered refusal not at all", async () => {
    const user = await insertUser();
    const meter = imageMeter(createTestSdk(), user.id, {
      model: "openai:gpt-image-1",
      provider: "openai",
      price: imagePrice,
    });

    await meter.record({ reached: false, answered: false, stored: false, stopped: false });
    await meter.record({ reached: true, answered: false, stored: false, stopped: true });

    expect(
      (await rowsOf(user.id)).map(({ costMicros, estimated }) => ({ costMicros, estimated })),
    ).toEqual([{ costMicros: 40_000, estimated: true }]);
  });
});
