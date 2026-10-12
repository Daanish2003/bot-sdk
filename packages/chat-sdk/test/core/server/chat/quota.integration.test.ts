import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import { usage } from "../../../../core/server/db/schema/usage";
import type { AppDeps, HostProvider, QuotaSetting } from "../../../../core/server/deps";
import { quotaLookup } from "../../../../core/server/chat/quota";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text, withUsage } from "../../../support/fake-adapter";
import { insertUser, type TestUser } from "../../../support/users";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";

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
// 200 micros: a Run of 100 input tokens costs 300, so one such Run takes the day over budget.
const budgetUsd = 0.0002;
const oneRun = withUsage(round(text("Hello")), {
  promptTokens: 100,
  completionTokens: 0,
  totalTokens: 100,
});

function chatRequest(command: Record<string, unknown>) {
  // useChat posts an AG-UI RunAgentInput; our command rides in `forwardedProps`.
  return new Request("http://localhost/api/chat/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [], forwardedProps: command }),
  });
}

/** A signed-in user on the Host Model with a scripted adapter and a titled Conversation. */
async function setup({
  user,
  getQuota,
  rounds = [oneRun, oneRun],
}: {
  user?: TestUser;
  getQuota?: QuotaSetting;
  rounds?: Parameters<typeof createFakeAdapter>[0]["rounds"];
}) {
  const owner = user ?? (await insertUser());
  const fake = createFakeAdapter({ rounds });
  const adapterCredentials: Array<Record<string, string>> = [];
  const deps: AppDeps = createTestDeps({
    hostProviders,
    adapterFor: (_model, credentials) => {
      adapterCredentials.push(credentials);
      return fake.adapter;
    },
    getQuota: quotaLookup(getQuota),
  });
  const conv = await insertConversation(owner, { model: sonnet, title: "Quota" });
  const send = () =>
    sendAs(
      chatRequest({
        conversationId: conv.id,
        parentId: null,
        text: "Hi",
        attachmentIds: [],
        model: sonnet,
        webSearch: false,
      }),
      owner,
      deps,
    );
  return { owner, deps, send, adapterCredentials };
}

/** Sends a Run and reads it to the end, so its reply is complete before the next send. */
async function sendToEnd(send: () => Promise<Response>): Promise<number> {
  const response = await send();
  await response.text();
  return response.status;
}

/** Records spend in `chat.usage` directly, at `createdAt`. */
async function spend(userId: string, costMicros: number, createdAt: Date) {
  await getTestDb().insert(usage).values({
    id: uuidv7(),
    userId,
    kind: "run",
    model: sonnet,
    inputTokens: 0,
    outputTokens: 0,
    costMicros,
    estimated: false,
    createdAt,
  });
}

/** Sets the clock; only `Date` is faked, so timers and the database run as they do. */
function atTime(iso: string) {
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Quota enforcement on a Run", () => {
  it("refuses a Run once the day's spend reaches the budget, and allows one in the next UTC day", async () => {
    atTime("2026-10-10T12:00:00Z");
    const { send } = await setup({
      getQuota: { budgetUsd, window: "day" },
    });

    expect(await sendToEnd(send)).toBe(200);

    const refused = await send();
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({
      message: expect.any(String),
      code: "quota_exceeded",
      resetsAt: "2026-10-11T00:00:00.000Z",
    });

    atTime("2026-10-11T00:00:00Z");
    expect(await sendToEnd(send)).toBe(200);
  });

  it("refuses a Run once the month's spend reaches the budget, and allows one in the next calendar month", async () => {
    atTime("2026-10-10T12:00:00Z");
    const { send } = await setup({
      getQuota: { budgetUsd, window: "month" },
    });
    expect(await sendToEnd(send)).toBe(200);

    // A new day in the same month keeps the spend.
    atTime("2026-10-31T23:59:59Z");
    const refused = await send();
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ resetsAt: "2026-11-01T00:00:00.000Z" });

    atTime("2026-11-01T00:00:00Z");
    expect(await sendToEnd(send)).toBe(200);
  });

  it("lets a Run started under budget finish, though it takes the spend over the budget", async () => {
    atTime("2026-10-10T12:00:00Z");
    const { owner, send } = await setup({
      getQuota: { budgetUsd, window: "day" },
      rounds: [
        withUsage(round(text("Finished")), {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        }),
      ],
    });

    const response = await send();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"delta":"Finished"');
    // 100 × $3/M + 50 × $15/M = 1050 micros, which is over the 200-micro budget.
    const [row] = await getTestDb().select().from(usage).where(eq(usage.userId, owner.id));
    expect(row?.costMicros).toBe(1050);
  });

  it("never refuses a Run when the Quota is null, the default, or a null from getQuota", async () => {
    atTime("2026-10-10T12:00:00Z");
    for (const getQuota of [undefined, null, () => null]) {
      const user = await insertUser();
      await spend(user.id, 1_000_000_000, new Date());
      const { send } = await setup({ user, getQuota });

      expect(await sendToEnd(send)).toBe(200);
    }
  });

  it("counts only the spend inside the window", async () => {
    atTime("2026-10-10T12:00:00Z");
    const user = await insertUser();
    // Yesterday's spend is over the budget, but the day's window starts at midnight UTC.
    await spend(user.id, 1_000, new Date("2026-10-09T23:59:59Z"));
    const { send } = await setup({ user, getQuota: { budgetUsd, window: "day" } });

    expect(await sendToEnd(send)).toBe(200);
  });

  it("lets a user who is over their Quota run on their own key, unmetered", async () => {
    atTime("2026-10-10T12:00:00Z");
    const user = await insertUser();
    await spend(user.id, 1_000, new Date());
    const { send, deps, adapterCredentials } = await setup({
      user,
      getQuota: { budgetUsd, window: "day" },
    });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });

    const response = await send();
    await response.text();

    expect(response.status).toBe(200);
    expect(adapterCredentials).toEqual([{ apiKey: "sk-ant-own-key" }]);
    const rows = await getTestDb().select().from(usage).where(eq(usage.userId, user.id));
    expect(rows).toHaveLength(1);
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
  it("returns the used percentage, the window and its reset time, and no money", async () => {
    atTime("2026-10-10T12:00:00Z");
    const user = await insertUser();
    // 100 of a 400-micro budget is a quarter.
    await spend(user.id, 100, new Date());
    const { deps } = await setup({ user, getQuota: { budgetUsd: 0.0004, window: "day" } });

    const quota = await chatRpc({ user, deps }).quota.read();

    expect(quota).toEqual({
      usedPercent: 25,
      window: "day",
      resetsAt: new Date("2026-10-11T00:00:00Z"),
    });
    const serialized = JSON.stringify(quota);
    expect(serialized).not.toMatch(/budget|cost|micros|usd/i);
  });

  it("caps the percentage at 100 once the spend is over the budget", async () => {
    atTime("2026-10-10T12:00:00Z");
    const user = await insertUser();
    await spend(user.id, 1_000, new Date());
    const { deps } = await setup({ user, getQuota: { budgetUsd, window: "day" } });

    expect(await chatRpc({ user, deps }).quota.read()).toMatchObject({ usedPercent: 100 });
  });

  it("reads null when the user's Quota is unlimited", async () => {
    const user = await insertUser();
    const { deps } = await setup({ user, getQuota: null });

    expect(await chatRpc({ user, deps }).quota.read()).toBeNull();
  });
});
