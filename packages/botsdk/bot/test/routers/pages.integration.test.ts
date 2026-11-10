import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineFeature, type FeatureContext } from "../../src";
import { emailChannel, webPushChannel } from "../../src/channel";
import { uuidv7 } from "../../src/lib/uuidv7";
import { exportUserData } from "../../src/user-data";
import { type HostProvider, quotaLookup, saveCredentials } from "../../src/models/internal";
import { claimJob, inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { bot, linkedIdentity, usage } from "../../src/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { followSend } from "@ai-chat/test-support/follow-send";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, text } from "@botsdk/testing/fake-adapter";
import {
  fakeEmailProvider,
  fakeMessagingAdapter,
  fakePushProvider,
} from "@botsdk/testing/fake-channel";

/*
 * Pages (ticket #1300): a feature that declares `pages` alerts the owner outside the app, through
 * the fake Channels on an idle runner and a fixed clock. Web push and Linked identities at once,
 * email 10 minutes later unless acknowledged.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const hostModel = "anthropic:claude-sonnet-5-5";
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
const domain = "bots.example";
const appUrl = "https://app.example";
const ownerEmail = "ada.owner@example.com";
const at = new Date("2026-10-22T09:00:00.000Z");
const minute = 60_000;
const silent = { error: () => {} };
const device = {
  endpoint: "https://push.example/send/phone",
  keys: { p256dh: "Bphone".padEnd(87, "A"), auth: "aphone".padEnd(22, "A") },
};

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const alert = {
  cause: "assignment_overdue",
  urgency: "routine",
  title: "An Assignment stalled",
  text: "Your Bot has not finished the refund for Grace.",
  path: "/representatives/one",
} as const;

/**
 * An owner with one Bot on the fake `telegram` platform, Linked there as `1001`, subscribed to web
 * push, with a feature that declares `pages` beside one that doesn't.
 */
async function ownerWithPages({ quota }: { quota?: { budgetUsd: number } } = {}) {
  const timer = fakeJobClock(at);
  const brain = createFakeAdapter({ rounds: [round(text("Hello"))] });
  const logged: string[] = [];
  const telegram = fakeMessagingAdapter({ id: "telegram", verifiesSender: true });
  const email = fakeEmailProvider();
  const push = fakePushProvider();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  const user = await insertUser();
  deps = createTestSdk({
    channels: [
      telegram.adapter,
      emailChannel({ provider: email.provider, domain, appUrl }),
      webPushChannel({ provider: push.provider, appUrl }),
    ],
    users: { verifiedEmail: async (userId) => (userId === user.id ? ownerEmail : null) },
    features: [
      defineFeature({ id: "frontDesk", needs: ["pages"] }),
      defineFeature({ id: "quietFeature" }),
    ],
    jobs,
    adapterFor: () => brain.adapter,
    clock: timer.clock.now,
    logger: { error: (text: unknown) => void logged.push(String(text)) },
    memory: false,
    // Only the Host's own credentials come under a Quota.
    ...(quota && { hostProviders, getQuota: quotaLookup({ ...quota, window: "month" }) }),
  });
  started.push(jobs);
  if (!quota) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({
    name: "Ada Lovelace",
    model: quota ? hostModel : model,
  });
  await client.channels.accounts.save({
    botId,
    platform: "telegram",
    credentials: { token: "1:s" },
  });
  await getTestDb().insert(linkedIdentity).values({
    id: uuidv7(),
    userId: user.id,
    platform: "telegram",
    platformUserId: "1001",
    handle: "@ada",
    workspaceId: null,
    linkedAt: at,
  });
  await client.notifications.push.subscribe(device);

  const contextOf = (id: string) =>
    deps!.parts.features.find(({ feature }) => feature.id === id)!.context;
  const { pages } = contextOf("frontDesk") as FeatureContext<"pages">;
  const page = (input: Partial<Record<keyof typeof alert, string>> = {}) =>
    getTestDb().transaction((tx) =>
      pages.send(tx, { userId: user.id, ...alert, ...(input as Partial<typeof alert>) }),
    );
  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  return {
    logged,
    user,
    client,
    deps,
    botId,
    timer,
    brain,
    telegram,
    email,
    push,
    contextOf,
    page,
    runDue,
  };
}

describe("Pages", () => {
  it("gives the service to a feature that declares it, and to no other", async () => {
    const { contextOf } = await ownerWithPages();

    expect(contextOf("frontDesk")).toHaveProperty("pages");
    expect(contextOf("quietFeature")).not.toHaveProperty("pages");
  });

  it("reaches web push and the Linked identity at once, with no email yet", async () => {
    const { page, runDue, push, telegram, email } = await ownerWithPages();

    const { id } = await page();
    await runDue();

    expect(push.sent).toEqual([
      {
        subscription: device,
        notification: {
          title: alert.title,
          body: alert.text,
          url: `${appUrl}${alert.path}`,
          tag: id,
        },
      },
    ]);
    expect(telegram.sends.map(({ message }) => message.chatId)).toEqual(["1001"]);
    expect(telegram.sends[0]!.message.text).toContain(alert.title);
    expect(telegram.sends[0]!.message.text).toContain(alert.text);
    expect(JSON.stringify(telegram.sends[0]!.message.control)).toContain(`${appUrl}${alert.path}`);
    expect(email.sent).toEqual([]);
  });

  it("emails the owner 10 minutes later, and not a minute sooner, when nobody acknowledged it", async () => {
    const { page, runDue, timer, email } = await ownerWithPages();

    await page();
    await runDue();
    timer.advance(10 * minute - 1);
    await runDue();
    expect(email.sent).toEqual([]);

    timer.advance(1);
    await runDue();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: ownerEmail, subject: alert.title });
    expect(email.sent[0]!.text).toContain(alert.text);
    expect(email.sent[0]!.text).toContain(`${appUrl}${alert.path}`);
  });

  it("sends no email once acknowledged", async () => {
    const { page, runDue, timer, email, client, push } = await ownerWithPages();

    const { id } = await page();
    await runDue();
    expect((await client.pages.list()).pages).toEqual([
      expect.objectContaining({ id, cause: alert.cause, urgency: "routine", title: alert.title }),
    ]);

    await client.pages.acknowledge({ id });
    timer.advance(10 * minute);
    await runDue();

    expect(email.sent).toEqual([]);
    expect(push.sent).toHaveLength(1);
    expect(await client.pages.list()).toEqual({ pages: [], truncated: false });
  });

  describe("once a day per cause", () => {
    const daily = async ({ contextOf, user }: Awaited<ReturnType<typeof ownerWithPages>>) => {
      const { pages } = contextOf("frontDesk") as FeatureContext<"pages">;
      return (input: { cause?: string; userId?: string } = {}) =>
        getTestDb().transaction((tx) =>
          pages.sendDaily(tx, { userId: user.id, ...alert, ...input }),
        );
    };

    it("raises a second Page of that cause only once a day has passed", async () => {
      const owner = await ownerWithPages();
      const send = await daily(owner);

      expect(await send()).not.toBeNull();
      expect(await send()).toBeNull();
      owner.timer.advance(24 * 60 * minute - 1);
      expect(await send()).toBeNull();
      owner.timer.advance(1);
      expect(await send()).not.toBeNull();

      expect((await owner.client.pages.list()).pages).toHaveLength(2);
    });

    it("keeps causes apart, and owners", async () => {
      const owner = await ownerWithPages();
      const send = await daily(owner);
      const other = await insertUser();

      expect(await send()).not.toBeNull();
      expect(await send({ cause: "quota_spent" })).not.toBeNull();
      expect(await send({ userId: other.id })).not.toBeNull();
    });

    it("counts one acknowledged, so acknowledging doesn't bring it back the same day", async () => {
      const owner = await ownerWithPages();
      const send = await daily(owner);

      const raised = await send();
      await owner.client.pages.acknowledge({ id: raised!.id });

      expect(await send()).toBeNull();
    });

    it("raises one of two sent at once", async () => {
      const owner = await ownerWithPages();
      const send = await daily(owner);

      const raised = await Promise.all([send(), send(), send()]);

      expect(raised.filter(Boolean)).toHaveLength(1);
    });
  });

  it("sends nothing at all when acknowledged before its jobs run", async () => {
    const { page, runDue, push, telegram, client } = await ownerWithPages();

    const { id } = await page();
    await client.pages.acknowledge({ id });
    await runDue();

    expect(push.sent).toEqual([]);
    expect(telegram.sends).toEqual([]);
  });

  it("goes out with the Quota spent and no model call", async () => {
    const { page, runDue, timer, push, telegram, email, user, client, botId, brain } =
      await ownerWithPages({ quota: { budgetUsd: 1 } });
    await getTestDb().insert(usage).values({
      id: uuidv7(),
      userId: user.id,
      kind: "turn",
      model: hostModel,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 1_000_000,
      estimated: false,
      createdAt: new Date(),
    });
    // The Quota really is spent: a send to the Bot is refused.
    await expect(client.bots.send({ botId, id: uuidv7(), text: "Hi" })).rejects.toMatchObject({
      status: 402,
      data: { code: "error.quotaSpent" },
    });

    await page();
    await runDue();
    timer.advance(10 * minute);
    await runDue();

    expect(push.sent).toHaveLength(1);
    expect(telegram.sends).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    expect(brain.calls).toEqual([]);
  });

  it("keeps a Page from another owner, who can neither read nor acknowledge it", async () => {
    const { page, deps, runDue, timer, email, client } = await ownerWithPages();
    const stranger = chatRpc({ user: await insertUser(), deps });

    const { id } = await page();

    expect(await stranger.pages.list()).toEqual({ pages: [], truncated: false });
    await expect(stranger.pages.acknowledge({ id })).rejects.toMatchObject({ status: 404 });
    expect((await client.pages.list()).pages).toHaveLength(1);

    timer.advance(10 * minute);
    await runDue();
    expect(email.sent).toHaveLength(1);
  });

  it("is in the owner's export, acknowledged or not", async () => {
    const { page, client, deps, user, timer } = await ownerWithPages();
    const { id } = await page();
    await client.pages.acknowledge({ id });
    const second = await page();

    const exported = await exportUserData(deps, user.id);

    expect((exported.bot as { pages: unknown }).pages).toEqual([
      expect.objectContaining({ id, cause: alert.cause, acknowledgedAt: timer.clock.now() }),
      expect.objectContaining({ id: second.id, acknowledgedAt: null }),
    ]);
  });

  it("logs a Page no Channel account could carry, rather than passing as sent", async () => {
    const { page, runDue, telegram, logged } = await ownerWithPages();
    telegram.rejected.add("1:s");

    const { id } = await page();
    await runDue();

    expect(telegram.sends).toEqual([]);
    expect(logged).toContain(`Couldn't send Page ${id} by messaging`);
  });

  it("keeps a Page short enough for a push, and for one message on any Channel", async () => {
    const { page, runDue, push, telegram, client } = await ownerWithPages();

    await page({ title: `${"t".repeat(500)}\nline two`, text: "x".repeat(10_000) });
    await runDue();

    const [listed] = (await client.pages.list()).pages;
    expect(listed!.title.length).toBe(120);
    expect(listed!.title).toMatch(/^t+…$/);
    expect(listed!.text.length).toBe(2000);
    expect(push.sent[0]!.notification.title).toBe(listed!.title);
    expect(telegram.delivered).toHaveLength(1);
  });

  it("refuses a path that isn't from the app's root, which could change the link's host", async () => {
    const { page } = await ownerWithPages();

    await expect(page({ path: "@evil.example/x" })).rejects.toThrow("from the app's root");
  });

  it("carries a Page through an unpaused Bot before a paused one", async () => {
    const { page, runDue, client, telegram, botId } = await ownerWithPages();
    const { id: second } = await client.bots.create({ name: "Grace Hopper", model });
    await client.channels.accounts.save({
      botId: second,
      platform: "telegram",
      credentials: { token: "2:s" },
    });
    await getTestDb().update(bot).set({ pausedAt: at }).where(eq(bot.id, botId));

    await page();
    await runDue();

    expect(telegram.sends.map(({ account }) => account.handle)).toEqual(["@bot_2"]);
  });

  it("tells the owner a Page's email takes no replies", async () => {
    const { page, runDue, timer, email } = await ownerWithPages();

    await page();
    timer.advance(10 * minute);
    await runDue();

    expect(email.sent[0]!.text).toContain("Replies to this address aren't read");
  });

  describe("outside the owner's hours", () => {
    const hour = 60 * minute;
    // 09:00 is inside these hours, which end at 12:00 UTC (the owner has written from no zone).
    const hours = { start: "08:00", end: "12:00" };
    const setHours = (client: Awaited<ReturnType<typeof ownerWithPages>>["client"]) =>
      client.notifications.update({ quietHours: hours, urgent: null, other: null });

    it("holds a routine Page until the hours end, then sends it", async () => {
      const { page, runDue, timer, push, telegram, client } = await ownerWithPages();
      await setHours(client);

      await page();
      await runDue();
      timer.advance(3 * hour - 1);
      await runDue();
      expect(push.sent).toEqual([]);
      expect(telegram.sends).toEqual([]);

      timer.advance(1);
      await runDue();
      expect(push.sent).toHaveLength(1);
      expect(telegram.sends).toHaveLength(1);
    });

    it("sends an emergency Page at once", async () => {
      const { page, runDue, push, telegram, client } = await ownerWithPages();
      await setHours(client);

      await page({ urgency: "emergency" });
      await runDue();

      expect(push.sent).toHaveLength(1);
      expect(telegram.sends).toHaveLength(1);
    });

    it("sends nothing for a waiting Page acknowledged before morning", async () => {
      const { page, runDue, timer, push, telegram, email, client } = await ownerWithPages();
      await setHours(client);

      const { id } = await page();
      await runDue();
      timer.advance(2 * hour);
      await client.pages.acknowledge({ id });
      timer.advance(hour + 20 * minute);
      await runDue();

      expect(push.sent).toEqual([]);
      expect(telegram.sends).toEqual([]);
      expect(email.sent).toEqual([]);
    });

    it("starts the 10-minute email wait when the held Page goes out", async () => {
      const { page, runDue, timer, email, push, client } = await ownerWithPages();
      await setHours(client);

      await page();
      timer.advance(3 * hour);
      await runDue();
      expect(push.sent).toHaveLength(1);
      expect(email.sent).toEqual([]);

      timer.advance(10 * minute - 1);
      await runDue();
      expect(email.sent).toEqual([]);
      timer.advance(1);
      await runDue();
      expect(email.sent).toHaveLength(1);
    });

    it("reads the hours in the zone the owner last wrote from", async () => {
      const { page, runDue, timer, push, client, botId } = await ownerWithPages();
      await setHours(client);
      // 09:00 UTC is 14:00 in Karachi, outside the hours there: the Page goes at once.
      const stream = await followSend(client, {
        botId,
        id: uuidv7(),
        text: "Hi",
        timeZone: "Asia/Karachi",
      });
      await stream.next();
      await stream.return(undefined);
      timer.advance(500);
      await runDue();

      await page();
      await runDue();

      expect(push.sent).toHaveLength(1);
    });
  });

  it("tries the owner's next Bot on the platform when one can't reach the chat", async () => {
    const { page, runDue, client, telegram } = await ownerWithPages();
    const { id: second } = await client.bots.create({ name: "Grace Hopper", model });
    await client.channels.accounts.save({
      botId: second,
      platform: "telegram",
      credentials: { token: "2:s" },
    });
    telegram.counts.sendFailures = 1;

    await page();
    await runDue();

    expect(telegram.sends.map(({ account }) => account.handle)).toEqual(["@bot_2"]);
  });

  it("marks a rejected Channel account and still reaches the owner through the next", async () => {
    const { page, runDue, client, telegram, botId } = await ownerWithPages();
    const { id: second } = await client.bots.create({ name: "Grace Hopper", model });
    await client.channels.accounts.save({
      botId: second,
      platform: "telegram",
      credentials: { token: "2:s" },
    });
    telegram.rejected.add("1:s");

    await page();
    await runDue();

    expect(telegram.sends.map(({ account }) => account.handle)).toEqual(["@bot_2"]);
    const [account] = await client.channels.accounts.list({ botId });
    expect(account).toMatchObject({ account: { status: "needs_attention" } });
  });
});

describe("the list of Pages", () => {
  it("keeps an older emergency in what it shows, however many newer routine Pages there are", async () => {
    const { page, client, timer } = await ownerWithPages();
    const { id } = await page({ urgency: "emergency" });
    for (let each = 0; each < 50; each += 1) {
      timer.advance(1_000);
      await page();
    }

    const { pages: listed, truncated } = await client.pages.list();

    expect(listed).toHaveLength(50);
    expect(truncated).toBe(true);
    expect(listed[0]).toMatchObject({ id, urgency: "emergency" });
  });

  it("says nothing was cut off with exactly 50 Pages", async () => {
    const { page, client, timer } = await ownerWithPages();
    for (let each = 0; each < 50; each += 1) {
      timer.advance(1_000);
      await page();
    }

    const { pages: listed, truncated } = await client.pages.list();

    expect(listed).toHaveLength(50);
    expect(truncated).toBe(false);
  });
});
