import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { channelAccount, job, linkedIdentity } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { emailChannel } from "../../src/channel";
import { fakeEmailProvider, fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import { saveCredentials } from "../../src/models/internal";
import type { BotSdkPlugin } from "../../src/plugin";
import { inProcessRunner, type JobRunner, claimJob } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";

/*
 * A Bot's Messages reach the user on a messaging Channel (spec #1044, ticket #1048): a reply goes
 * back where the user last wrote from, and Messages the Bot sends first follow the notification
 * routes, which can name a linked messaging Channel. Through the fake messaging adapter.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const poll = { timeout: 10_000 };
// 09:00 UTC is 02:00 in Los Angeles (summer time), and the Check-in an hour later is 03:00 there.
const at = new Date("2026-10-22T09:00:00.000Z");
const losAngeles = "America/Los_Angeles";
const night = { start: "22:00", end: "07:00" };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: { jobs: JobRunner; part: BotSdkPlugin; deps: TestDeps }[] = [];

afterEach(async () => {
  for (const { jobs, part, deps } of started.splice(0)) {
    await part.stop!(deps);
    await jobs.stop();
  }
});

const says = (text: string, more: Record<string, unknown> = {}) =>
  toolCall({ name: "send_to_user", input: { text, endTurn: true, ...more } });

const setsCheckIn = (minutes: number) =>
  toolCall({
    name: "set_check_in",
    input: { at: new Date(at.getTime() + minutes * 60_000).toISOString(), note: "Follow up" },
  });

/**
 * A Bot whose Model plays `rounds`, its Channel account `@bot_1` on the fake `telegram` platform and
 * its user Linked as platform user `1001` (unless `linked` is false), on an idle runner and a fixed
 * clock.
 */
async function telegramBot(
  rounds: Round[],
  {
    linked = true,
    platform = "telegram",
    email = false,
  }: { linked?: boolean; platform?: string; email?: boolean } = {},
) {
  const timer = fakeJobClock(at);
  const brain = createFakeAdapter({ rounds });
  const fake = fakeMessagingAdapter({ id: platform });
  const logged: string[] = [];
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  const user = await insertUser();
  deps = createTestSdk({
    channels: [
      fake.adapter,
      ...(email
        ? [
            emailChannel({
              provider: fakeEmailProvider().provider,
              domain: "bots.example",
              appUrl: "https://app.example",
            }),
          ]
        : []),
    ],
    jobs,
    adapterFor: () => brain.adapter,
    clock: timer.clock.now,
    logger: { error: (text: unknown) => void logged.push(String(text)) },
    memory: false,
  });
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada Lovelace", model });
  await client.channels.accounts.save({
    botId,
    platform,
    credentials: { token: "1:secret" },
  });
  const link = () =>
    getTestDb().insert(linkedIdentity).values({
      id: uuidv7(),
      userId: user.id,
      platform,
      platformUserId: "1001",
      handle: "@ada",
      workspaceId: null,
      linkedAt: at,
    });
  if (linked) await link();
  const part = deps.parts.all.find((candidate) => candidate.id === "channel")!;
  await part.start!(deps);
  started.push({ jobs, part, deps });
  await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(true);

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  /** The user writes to the Bot on Telegram, and the Turn it starts runs. */
  const write = async (text: string) => {
    await fake.deliver("@bot_1", { sourceId: `1001:${uuidv7()}`, text });
    timer.advance(3_000);
    await runDue();
  };
  /** The user writes to the Bot in the app, from `timeZone` when given, and the Turn runs. */
  const writeInApp = async (text: string, timeZone?: string) => {
    await client.bots.send({ botId, id: uuidv7(), text, ...(timeZone && { timeZone }) });
    timer.advance(3_000);
    await runDue();
  };
  /** Lets the hour pass to the Check-in, and runs the Turn it starts. */
  const checkIn = async () => {
    timer.advance(60 * 60_000);
    await runDue();
    timer.advance(3_000);
    await runDue();
  };
  const settle = (settings: Partial<Parameters<typeof client.notifications.update>[0]>) =>
    client.notifications.update({ quietHours: null, urgent: null, other: null, ...settings });
  const deliveryJobs = () => getTestDb().select().from(job).where(eq(job.name, "channel.deliver"));
  const texts = () => fake.sends.map((one) => one.message.text);
  return {
    fake,
    client,
    user,
    botId,
    timer,
    runDue,
    write,
    writeInApp,
    checkIn,
    settle,
    deliveryJobs,
    texts,
    logged,
    link,
  };
}

/** A Bot that sets a Check-in, then says `checkInSays` (with `more`) when it fires. */
const checkingIn = (
  checkInSays: string,
  more: Record<string, unknown> = {},
  options?: Parameters<typeof telegramBot>[1],
) =>
  telegramBot(
    [
      round(setsCheckIn(60)),
      round(says("I'll check back in an hour.")),
      round(says(checkInSays, more)),
    ],
    options,
  );

describe("a reply on a messaging Channel", () => {
  it("goes back to the chat of the Linked identity, as text", async () => {
    const { write, fake, texts } = await telegramBot([round(says("Booked **Friday**."))]);

    await write("Book me a table for Friday");

    expect(texts()).toEqual(["Booked **Friday**."]);
    expect(fake.sends[0]!.message.chatId).toBe("1001");
    expect(fake.sends[0]!.account.handle).toBe("@bot_1");
  });

  it("goes back on any messaging adapter the Host installed, not only Telegram", async () => {
    const { write, texts } = await telegramBot([round(says("Done."))], { platform: "fake" });

    await write("Book me a table");

    expect(texts()).toEqual(["Done."]);
  });

  it("stays on web when the user last wrote from the app", async () => {
    const { writeInApp, fake } = await telegramBot([round(says("Done."))]);

    await writeInApp("Book me a table");

    expect(fake.sends).toEqual([]);
  });

  it("is not sent once the user has unlinked", async () => {
    const { write, fake, client, deliveryJobs } = await telegramBot([round(says("Done."))]);
    await client.channels.identities.unlink({ platform: "telegram" });

    await write("Book me a table");

    expect(fake.sends).toEqual([]);
    expect(await deliveryJobs()).toEqual([]);
  });
});

describe("the notification routes", () => {
  it("refuse telegram unless the user is linked there", async () => {
    const { settle, client, link } = await telegramBot([], { linked: false });

    await expect(settle({ other: "telegram" })).rejects.toThrow();
    await link();
    await settle({ other: "telegram" });
    expect(await client.notifications.get()).toMatchObject({ other: "telegram" });
  });

  it("send a Message the Bot starts to the Linked identity", async () => {
    const { writeInApp, checkIn, settle, fake, texts } = await checkingIn("Any news?");
    await settle({ other: "telegram" });

    await writeInApp("Remind me later");
    await checkIn();

    expect(texts()).toEqual(["Any news?"]);
    expect(fake.sends[0]!.message.chatId).toBe("1001");
  });

  it("send an urgent Message where urgent ones go, apart from the rest", async () => {
    const { writeInApp, checkIn, settle, texts } = await checkingIn("Your flight is cancelled.", {
      urgent: true,
    });
    await settle({ urgent: "telegram", other: "in_app" });

    await writeInApp("Remind me later");
    await checkIn();

    expect(texts()).toEqual(["Your flight is cancelled."]);
  });

  it("fall back to the defaults when the user has unlinked", async () => {
    const { writeInApp, checkIn, settle, fake, client, deliveryJobs } =
      await checkingIn("Any news?");
    await settle({ other: "telegram" });
    await client.channels.identities.unlink({ platform: "telegram" });

    await writeInApp("Remind me later");
    await checkIn();

    // The default is the Channel the user last wrote from: the app.
    expect(fake.sends).toEqual([]);
    expect(await deliveryJobs()).toEqual([]);
  });

  it("fall back to the defaults when the Bot has no active Channel account", async () => {
    const { writeInApp, checkIn, settle, fake, client, botId, deliveryJobs } =
      await checkingIn("Any news?");
    await settle({ other: "telegram" });
    await client.channels.accounts.remove({ botId, platform: "telegram" });

    await writeInApp("Remind me later");
    await checkIn();

    expect(fake.sends).toEqual([]);
    expect(await deliveryJobs()).toEqual([]);
  });

  it("by default, send a Message the Bot starts to the messaging Channel the user last wrote from", async () => {
    const { write, checkIn, texts, client, botId } = await checkingIn(
      "Any news?",
      {},
      {
        email: true,
      },
    );

    await write("Remind me later");
    expect((await client.channels.email.address({ botId })).nextChannel).toBe("telegram");
    await checkIn();

    expect(texts()).toEqual(["I'll check back in an hour.", "Any news?"]);
  });

  it("fall back to the defaults when the Host has no adapter for the route's platform", async () => {
    const { write, checkIn, settle, texts, user, botId } = await checkingIn(
      "Your flight is cancelled.",
      { urgent: true },
      { platform: "fake" },
    );
    // Left from when the Host had a telegram adapter: a Linked identity and an active account.
    await getTestDb().insert(linkedIdentity).values({
      id: uuidv7(),
      userId: user.id,
      platform: "telegram",
      platformUserId: "1001",
      handle: "@ada",
      workspaceId: null,
      linkedAt: at,
    });
    await getTestDb().insert(channelAccount).values({
      id: uuidv7(),
      botId,
      platform: "telegram",
      platformBotId: "9",
      handle: "@old_bot",
      encrypted: "unreadable",
      status: "active",
      createdAt: at,
      updatedAt: at,
    });
    await settle({ urgent: "telegram" });

    await write("Remind me later");
    await checkIn();

    // The default: the Channel the user last wrote from.
    expect(texts()).toEqual(["I'll check back in an hour.", "Your flight is cancelled."]);
  });

  it("hold back a Message that isn't urgent during Quiet hours", async () => {
    const { writeInApp, checkIn, settle, fake, deliveryJobs } = await checkingIn("Any news?");
    await settle({ quietHours: night, other: "telegram" });

    await writeInApp("Remind me later", losAngeles);
    await checkIn();

    expect(fake.sends).toEqual([]);
    expect(await deliveryJobs()).toEqual([]);
  });

  it("let an urgent Message through during Quiet hours", async () => {
    const { writeInApp, checkIn, settle, texts } = await checkingIn("Your flight is cancelled.", {
      urgent: true,
    });
    await settle({ quietHours: night, urgent: "telegram" });

    await writeInApp("Remind me later", losAngeles);
    await checkIn();

    expect(texts()).toEqual(["Your flight is cancelled."]);
  });
});

describe("delivery on a messaging Channel", () => {
  it("is a channel.deliver job, retried by the runner like email", async () => {
    const { write, fake, timer, runDue, deliveryJobs, texts } = await telegramBot([
      round(says("Done.")),
    ]);
    fake.counts.sendFailures = 1;

    await write("Book me a table");
    expect(texts()).toEqual([]);
    timer.advance(60_000);
    await runDue();

    expect(texts()).toEqual(["Done."]);
    expect(await deliveryJobs()).toEqual([
      expect.objectContaining({ status: "succeeded", attempts: 2 }),
    ]);
  });

  it("gives up after the runner's retries and logs it, the Message staying in the app", async () => {
    const { write, fake, timer, runDue, deliveryJobs, logged, client, botId } = await telegramBot([
      round(says("Done.")),
    ]);
    fake.counts.sendFailures = 100;

    await write("Book me a table");
    for (let attempt = 0; attempt < 3; attempt++) {
      timer.advance(10 * 60_000);
      await runDue();
    }

    expect(fake.sends).toEqual([]);
    expect(await deliveryJobs()).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(logged.filter((line) => line.includes("Couldn't send"))).toHaveLength(1);
    expect((await client.bots.get({ botId })).messages.at(-1)).toMatchObject({ text: "Done." });
  });

  it("marks the Channel account as needing attention on rejected credentials, without retries", async () => {
    const { write, fake, timer, runDue, deliveryJobs, botId } = await telegramBot([
      round(says("Done.")),
    ]);
    fake.rejected.add("1:secret");

    await write("Book me a table");
    timer.advance(10 * 60_000);
    await runDue();

    const [account] = await getTestDb()
      .select()
      .from(channelAccount)
      .where(and(eq(channelAccount.botId, botId), eq(channelAccount.platform, "telegram")));
    expect(account).toMatchObject({ status: "needs_attention", reason: "Unauthorized" });
    expect(await deliveryJobs()).toEqual([
      expect.objectContaining({ status: "failed", attempts: 1 }),
    ]);
  });
});
