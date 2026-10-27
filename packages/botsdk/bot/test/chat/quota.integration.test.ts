import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials, quotaLookup } from "../../src/models/internal";
import { usage } from "../../src/storage";
import type { HostProvider, QuotaSetting } from "../../src/models/internal";
import { uuidv7 } from "../../src/lib/uuidv7";
import { botOf, botSdk, sendToTurnEnd, stopBotRunners } from "@ai-chat/test-support/bot-turns";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round, toolCall, withUsage } from "@botsdk/testing/fake-adapter";
import { followSend } from "@ai-chat/test-support/follow-send";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { insertUser, type TestUser } from "@ai-chat/test-support/users";
import { getTestDb } from "@ai-chat/test-support/test-database";

const sonnet = "anthropic:claude-sonnet-5-5";
// $3 per 1M input tokens and $15 per 1M output tokens, so a token costs as many micros as its price.
const hostProviders: HostProvider[] = [
  {
    provider: "anthropic",
    credentials: { apiKey: "sk-host-secret-never-stored" },
    models: [
      {
        modelId: "claude-sonnet-5-5",
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
];
// 200 micros: a Turn of 100 input tokens costs 300, so one such Turn takes the window over budget.
const budgetUsd = 0.0002;

/** A Step that sends `text` to the user and ends the Turn, reporting `usage`. */
const sends = (
  text: string,
  { input = 100, output = 0 }: { input?: number; output?: number } = {},
) =>
  withUsage(round(toolCall({ name: "send_to_user", input: { text, endTurn: true } })), {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input + output,
  });

afterEach(async () => {
  await stopBotRunners();
  vi.useRealTimers();
});

/** A user with a Bot on the Host's Model, whose Turns play `rounds`, under `getQuota`. */
async function setup({
  user,
  getQuota,
  rounds = [sends("Hello"), sends("Again")],
}: {
  user?: TestUser;
  getQuota?: QuotaSetting;
  rounds?: Parameters<typeof createFakeAdapter>[0]["rounds"];
}) {
  const owner = user ?? (await insertUser());
  const fake = createFakeAdapter({ rounds });
  const adapterCredentials: Array<Record<string, string>> = [];
  const { deps } = await botSdk({
    hostProviders,
    adapterFor: (_model, credentials) => {
      adapterCredentials.push(credentials);
      return fake.adapter;
    },
    getQuota: quotaLookup(getQuota),
  });
  const { client, botId } = await botOf(deps, owner, sonnet);
  return { owner, deps, client, botId, adapterCredentials };
}

/** Records spend in `botsdk.usage` directly, at `createdAt`. */
async function spend(userId: string, costMicros: number, createdAt: Date) {
  await getTestDb().insert(usage).values({
    id: uuidv7(),
    userId,
    kind: "turn",
    model: sonnet,
    inputTokens: 0,
    outputTokens: 0,
    costMicros,
    estimated: false,
    createdAt,
  });
}

/** A send that the Quota refuses: its 402 and code. */
async function refusedSend(client: ReturnType<typeof chatRpc>, botId: string) {
  return followSend(client, { botId, id: uuidv7(), text: "Hi" }).then(
    () => {
      throw new Error("expected the send to be refused");
    },
    (caught: unknown) => caught as { status?: number; data?: { code?: string } },
  );
}

const usageOf = (userId: string) =>
  getTestDb().select().from(usage).where(eq(usage.userId, userId));

/**
 * Waits out the last seconds before the next UTC `window` starts, so the window a test computes
 * from the clock is still the one the send is checked in.
 */
async function clearOfBoundary(window: "day" | "month") {
  const now = new Date();
  const next =
    window === "day"
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
      : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const left = next - now.getTime();
  if (left < 5_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
}

describe("Quota enforcement on a Bot's Turn", () => {
  it("refuses a send once the window's spend reaches the budget, after a Turn that spent it", async () => {
    const { client, botId } = await setup({ getQuota: { budgetUsd, window: "day" } });

    expect((await sendToTurnEnd(client, botId)).at(-1)).toEqual({
      type: "turnEnded",
      status: "complete",
    });

    expect(await refusedSend(client, botId)).toMatchObject({
      status: 402,
      data: { code: "error.quotaSpent" },
    });
  });

  it("counts only the spend inside the day's window, which starts at midnight UTC", async () => {
    await clearOfBoundary("day");
    const now = new Date();
    const lastMidnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const yesterday = await insertUser();
    await spend(yesterday.id, 1_000, new Date(lastMidnight.getTime() - 1_000));
    const today = await insertUser();
    await spend(today.id, 1_000, lastMidnight);

    const allowed = await setup({ user: yesterday, getQuota: { budgetUsd, window: "day" } });
    const refused = await setup({ user: today, getQuota: { budgetUsd, window: "day" } });

    expect((await sendToTurnEnd(allowed.client, allowed.botId)).at(-1)).toMatchObject({
      status: "complete",
    });
    expect(await refusedSend(refused.client, refused.botId)).toMatchObject({ status: 402 });
  });

  it("counts the whole calendar month's spend in a month's window, and none of the month before", async () => {
    await clearOfBoundary("month");
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const thisMonth = await insertUser();
    await spend(thisMonth.id, 1_000, monthStart);
    const lastMonth = await insertUser();
    await spend(lastMonth.id, 1_000, new Date(monthStart.getTime() - 1_000));

    const refused = await setup({ user: thisMonth, getQuota: { budgetUsd, window: "month" } });
    const allowed = await setup({ user: lastMonth, getQuota: { budgetUsd, window: "month" } });

    expect(await refusedSend(refused.client, refused.botId)).toMatchObject({ status: 402 });
    expect((await sendToTurnEnd(allowed.client, allowed.botId)).at(-1)).toMatchObject({
      status: "complete",
    });
  });

  it("lets a Turn started under budget finish, though it takes the spend over the budget", async () => {
    const { owner, client, botId } = await setup({
      getQuota: { budgetUsd, window: "day" },
      rounds: [sends("Finished", { input: 100, output: 50 })],
    });

    const events = await sendToTurnEnd(client, botId);

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    // 100 × $3/M + 50 × $15/M = 1050 micros, which is over the 200-micro budget.
    expect(await usageOf(owner.id)).toMatchObject([{ costMicros: 1050 }]);
  });

  it("never refuses a send when the Quota is null, the default, or a null from getQuota", async () => {
    for (const getQuota of [undefined, null, () => null]) {
      const user = await insertUser();
      await spend(user.id, 1_000_000_000, new Date());
      const { client, botId } = await setup({ user, getQuota });

      expect((await sendToTurnEnd(client, botId)).at(-1)).toMatchObject({ status: "complete" });
    }
  });

  it("lets a user who is over their Quota run on their own key, at no cost", async () => {
    const user = await insertUser();
    await spend(user.id, 1_000, new Date());
    const { deps, client, botId, adapterCredentials } = await setup({
      user,
      getQuota: { budgetUsd, window: "day" },
    });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });

    const events = await sendToTurnEnd(client, botId);

    expect(events.at(-1)).toMatchObject({ status: "complete" });
    expect(adapterCredentials).toEqual([{ apiKey: "sk-ant-own-key" }]);
    // The spend row from before, and the Turn's model call, recorded at cost 0.
    expect((await usageOf(user.id)).map((row) => row.costMicros).toSorted((a, b) => a - b)).toEqual(
      [0, 1_000],
    );
  });
});

describe("quotaLookup", () => {
  it("returns a fixed Quota for every user, and passes a function the user id", async () => {
    const quota = { budgetUsd, window: "day" as const };
    expect(await quotaLookup(quota)("any-user")).toEqual(quota);
    expect(await quotaLookup(null)("any-user")).toBeNull();
    expect(await quotaLookup(undefined)("any-user")).toBeNull();

    const seen: string[] = [];
    const lookup = quotaLookup((userId) => {
      seen.push(userId);
      return null;
    });
    expect(await lookup("user-1")).toBeNull();
    expect(seen).toEqual(["user-1"]);
  });
});

describe("the Quota read", () => {
  /** The caller's client on an SDK with `getQuota`, at a fixed time. */
  function clientAt(user: TestUser, getQuota: QuotaSetting) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    return chatRpc({
      user,
      deps: createTestSdk({ hostProviders, getQuota: quotaLookup(getQuota) }),
    });
  }

  it("returns the used percentage, the window and its reset time, and no money", async () => {
    const user = await insertUser();
    // 100 of a 400-micro budget is a quarter.
    await spend(user.id, 100, new Date("2026-10-10T11:00:00Z"));

    const quota = await clientAt(user, { budgetUsd: 0.0004, window: "day" }).models.readQuota();

    expect(quota).toEqual({
      usedPercent: 25,
      window: "day",
      resetsAt: new Date("2026-10-11T00:00:00Z"),
    });
    const serialized = JSON.stringify(quota);
    expect(serialized).not.toMatch(/budget|cost|micros|usd/i);
  });

  it("caps the percentage at 100 once the spend is over the budget", async () => {
    const user = await insertUser();
    await spend(user.id, 1_000, new Date("2026-10-10T11:00:00Z"));

    expect(await clientAt(user, { budgetUsd, window: "day" }).models.readQuota()).toMatchObject({
      usedPercent: 100,
    });
  });

  it("reads null when the user's Quota is unlimited", async () => {
    const user = await insertUser();

    expect(await clientAt(user, null).models.readQuota()).toBeNull();
  });
});
