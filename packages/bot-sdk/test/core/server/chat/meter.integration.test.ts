import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createHookEmitter, type UsageEvent } from "../../../../core/server/chat/hooks";
import {
  freeMeter,
  hostEmbeddingMeter,
  hostModelMeter,
  hostSearchMeter,
  hostTranscriptionMeter,
  imageMeter,
} from "../../../../core/server/chat/meter";
import { usage } from "../../../../core/server/db/schema/usage";
import { createTestDeps } from "../../../support/deps";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const sonnet = "anthropic:claude-sonnet-5-5";
// $3 per 1M input tokens and $15 per 1M output tokens, so a token costs as many micros as its price.
const price = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
const usageOf = { input: 100, output: 20, reasoning: 0, cached: 0, estimated: false };

async function rowsOf(userId: string) {
  return getTestDb().select().from(usage).where(eq(usage.userId, userId));
}

/** Deps whose `onUsage` hook collects every usage event, and a $1-a-day Quota. */
function depsWithHook(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  const events: UsageEvent[] = [];
  const deps = createTestDeps({
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

  it("takes the Provider's reported cost over the token price", async () => {
    const user = await insertUser();
    const meter = hostModelMeter(createTestDeps(), user.id, sonnet, price);

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

  it("estimates an embedding's tokens from its characters when the Provider counts none", async () => {
    const user = await insertUser();
    const meter = hostEmbeddingMeter(createTestDeps(), user.id, {
      model: "gemini:gemini-embedding-001",
      pricePerMillionTokensUsd: 2,
    });

    await meter.record({ characters: 10 });
    await meter.record({ characters: 10, reportedTokens: 7 });

    expect(
      (await rowsOf(user.id)).map(({ inputTokens, costMicros, estimated }) => ({
        inputTokens,
        costMicros,
        estimated,
      })),
    ).toEqual(
      expect.arrayContaining([
        { inputTokens: 3, costMicros: 6, estimated: true },
        { inputTokens: 7, costMicros: 14, estimated: false },
      ]),
    );
  });

  it("bills a Groq transcription for at least its minimum seconds", async () => {
    const user = await insertUser();
    const meter = hostTranscriptionMeter(createTestDeps(), user.id, {
      provider: "groq",
      model: "groq:whisper-large-v3-turbo",
      pricePerMinuteUsd: 0.06,
    });

    await meter.record({ durationSeconds: 3 });

    expect((await rowsOf(user.id))[0]).toMatchObject({
      kind: "transcription",
      costMicros: Math.round((10 / 60) * 0.06 * 1_000_000),
      estimated: true,
    });
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
    const meter = imageMeter(createTestDeps(), user.id, {
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
