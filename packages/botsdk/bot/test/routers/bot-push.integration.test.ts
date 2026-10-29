import type { NotificationSettings } from "@botsdk/client/bot/notifications";
import { asc, eq, like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { uuidv7 } from "../../src/lib/uuidv7";
import { fakeEmailProvider, fakePushProvider } from "@botsdk/testing/fake-channel";
import { emailChannel, webPushChannel } from "../../src/channel";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner, claimJob } from "../../src/runner/internal";
import { job, pushSubscription } from "../../src/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";

/*
 * The web push Channel (spec #1024): the devices a user subscribes, and the pushes of Messages from
 * Turns the user didn't start, through the fake push provider.
 */

const timeout = { timeout: 30_000 };
const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const domain = "bots.example";
const appUrl = "https://app.example";
const ownerEmail = "ada.owner@example.com";
// 09:00 UTC is 02:00 in Los Angeles (summer time), and the Check-in an hour later is 03:00 there.
const at = new Date("2026-10-22T09:00:00.000Z");
const losAngeles = "America/Los_Angeles";
const night = { start: "22:00", end: "07:00" };

/** A device's subscription as the browser gives it. */
const device = (name: string) => ({
  endpoint: `https://push.example/send/${name}`,
  keys: { p256dh: `BKey-${name}`, auth: `auth-${name}` },
});

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const says = (text: string, more: Record<string, unknown> = {}) =>
  toolCall({ name: "send_to_user", input: { text, endTurn: true, ...more } });

const setsCheckIn = (minutes: number) =>
  toolCall({
    name: "set_check_in",
    input: { at: new Date(at.getTime() + minutes * 60_000).toISOString(), note: "Follow up" },
  });

/**
 * A Bot whose Model plays `rounds`, with the email Channel and the web push Channel (unless
 * `push: false`) over the fake providers, on an idle runner and a fixed clock.
 */
async function pushedBot(rounds: Round[], { push: pushOn = true } = {}) {
  const timer = fakeJobClock(at);
  const fake = createFakeAdapter({ rounds });
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
      emailChannel({ provider: email.provider, domain, appUrl }),
      ...(pushOn ? [webPushChannel({ provider: push.provider, appUrl: `${appUrl}/` })] : []),
    ],
    users: { verifiedEmail: async (userId) => (userId === user.id ? ownerEmail : null) },
    jobs,
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    logger: silent,
    memory: false,
  });
  started.push(jobs);
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada Lovelace", model });

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  /** Sends the Bot a web Message, from `timeZone` when given, then runs the Turn it starts. */
  const write = async (text: string, timeZone?: string) => {
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
  const assistantMessages = async () =>
    (await client.bots.get({ botId })).messages.filter((entry) => entry.role === "assistant");
  const settle = (settings: Partial<NotificationSettings>) =>
    client.notifications.update({ quietHours: null, urgent: null, other: null, ...settings });
  const subscribed = async () =>
    (
      await getTestDb()
        .select({ endpoint: pushSubscription.endpoint })
        .from(pushSubscription)
        .where(eq(pushSubscription.userId, user.id))
        .orderBy(asc(pushSubscription.endpoint))
    ).map((row) => row.endpoint);
  const pushJobs = () =>
    getTestDb()
      .select({ key: job.idempotencyKey, status: job.status, attempts: job.attempts })
      .from(job)
      .where(like(job.idempotencyKey, "channel.deliver:%:push"));

  return {
    client,
    deps,
    user,
    botId,
    timer,
    runDue,
    pushed: push.sent,
    gone: push.gone,
    failing: push.failing,
    emailed: email.sent,
    write,
    checkIn,
    assistantMessages,
    settle,
    subscribed,
    pushJobs,
  };
}

/** A Bot that sets a Check-in, then says `checkInSays` (with `more`) when it fires. */
const checkingIn = (checkInSays: string, more: Record<string, unknown> = {}, options = {}) =>
  pushedBot(
    [
      round(setsCheckIn(60)),
      round(says("I'll check back in an hour.")),
      round(says(checkInSays, more)),
    ],
    options,
  );

describe("the push subscription API", () => {
  it("gives the Host's VAPID public key, or null with no web push adapter", timeout, async () => {
    const { client } = await pushedBot([]);
    expect(await client.notifications.push.key()).toBe("BFakeVapidPublicKey");

    const { client: withoutPush } = await pushedBot([], { push: false });
    expect(await withoutPush.notifications.push.key()).toBeNull();
  });

  it(
    "saves each device for the signed-in user, and removes only the user's own",
    timeout,
    async () => {
      const { client, deps, subscribed } = await pushedBot([]);

      await client.notifications.push.subscribe(device("laptop"));
      await client.notifications.push.subscribe(device("phone"));
      await client.notifications.push.subscribe(device("phone"));
      expect(await subscribed()).toEqual([device("laptop").endpoint, device("phone").endpoint]);

      const other = chatRpc({ user: await insertUser(), deps });
      await other.notifications.push.unsubscribe({ endpoint: device("laptop").endpoint });
      expect(await subscribed()).toHaveLength(2);

      await client.notifications.push.unsubscribe({ endpoint: device("laptop").endpoint });
      expect(await subscribed()).toEqual([device("phone").endpoint]);
    },
  );

  it("moves a device to the user who subscribes it next", timeout, async () => {
    const { client, deps, subscribed } = await pushedBot([]);
    await client.notifications.push.subscribe(device("shared"));

    const other = chatRpc({ user: await insertUser(), deps });
    await other.notifications.push.subscribe(device("shared"));

    expect(await subscribed()).toEqual([]);
  });

  it("refuses an endpoint that isn't HTTPS, or keys that aren't base64url", timeout, async () => {
    const { client } = await pushedBot([]);

    for (const subscription of [
      { ...device("laptop"), endpoint: "http://push.example/send/laptop" },
      { ...device("laptop"), endpoint: "file:///etc/passwd" },
      { ...device("laptop"), keys: { p256dh: "not base64!", auth: "auth" } },
    ]) {
      await expect(client.notifications.push.subscribe(subscription)).rejects.toThrow(
        "Input validation failed",
      );
    }
  });
});

describe("a pushed Message", () => {
  it(
    "goes to each of the user's devices with the Bot's name, its first line and the Conversation",
    timeout,
    async () => {
      const { client, botId, write, checkIn, settle, pushed, emailed, assistantMessages } =
        await checkingIn("\nYour train leaves at 9.\nPlatform 4.");
      await client.notifications.push.subscribe(device("laptop"));
      await client.notifications.push.subscribe(device("phone"));
      await settle({ other: "push" });

      await write("Remind me later");
      await checkIn();

      const [, sent] = await assistantMessages();
      expect(pushed.map((one) => one.subscription.endpoint).toSorted()).toEqual([
        device("laptop").endpoint,
        device("phone").endpoint,
      ]);
      expect(pushed[0]!.subscription).toEqual(
        device(pushed[0]!.subscription.endpoint.split("/").at(-1)!),
      );
      expect(pushed[0]!.notification).toEqual({
        title: "Ada Lovelace",
        body: "Your train leaves at 9.",
        url: `${appUrl}/bots/${botId}`,
        tag: sent!.id,
      });
      expect(emailed).toEqual([]);
    },
  );

  it(
    "is an urgent one, when urgent Messages have no choice and a device is subscribed",
    timeout,
    async () => {
      const { client, write, checkIn, pushed } = await checkingIn("Your flight is cancelled.", {
        urgent: true,
      });
      await client.notifications.push.subscribe(device("phone"));

      await write("Remind me later");
      await checkIn();

      expect(pushed.map((one) => one.notification.body)).toEqual(["Your flight is cancelled."]);
    },
  );

  it("isn't the rest, when they have no choice", timeout, async () => {
    const { client, write, checkIn, pushed, pushJobs } = await checkingIn("Any news?");
    await client.notifications.push.subscribe(device("phone"));

    await write("Remind me later");
    await checkIn();

    expect(pushed).toEqual([]);
    expect(await pushJobs()).toEqual([]);
  });

  it(
    "isn't an urgent one with no choice and no device: it goes where the user wrote",
    timeout,
    async () => {
      const { write, checkIn, pushed, pushJobs } = await checkingIn("Your flight is cancelled.", {
        urgent: true,
      });

      await write("Remind me later");
      await checkIn();

      expect(pushed).toEqual([]);
      expect(await pushJobs()).toEqual([]);
    },
  );

  it("is never pushed by a Host with no web push adapter", timeout, async () => {
    const { client, write, checkIn, settle, pushJobs } = await checkingIn(
      "Your flight is cancelled.",
      { urgent: true },
      { push: false },
    );
    await client.notifications.push.subscribe(device("phone"));
    await settle({ urgent: "push" });

    await write("Remind me later");
    await checkIn();

    expect(await pushJobs()).toEqual([]);
  });

  it("is held back during quiet hours, and stays in the Conversation", timeout, async () => {
    const { client, write, checkIn, settle, pushed, assistantMessages } =
      await checkingIn("Any news?");
    await client.notifications.push.subscribe(device("phone"));
    await settle({ quietHours: night, other: "push" });

    await write("Remind me later", losAngeles);
    await checkIn();

    expect((await assistantMessages()).at(-1)).toMatchObject({ text: "Any news?" });
    expect(pushed).toEqual([]);
  });

  it("gets through quiet hours when urgent", timeout, async () => {
    const { client, write, checkIn, settle, pushed } = await checkingIn(
      "Your flight is cancelled.",
      { urgent: true },
    );
    await client.notifications.push.subscribe(device("phone"));
    await settle({ quietHours: night, urgent: "push", other: "push" });

    await write("Remind me later", losAngeles);
    await checkIn();

    expect(pushed).toHaveLength(1);
  });

  it("isn't a reply to the user's own Message", timeout, async () => {
    const { client, write, settle, pushed, pushJobs } = await pushedBot([round(says("Noted."))]);
    await client.notifications.push.subscribe(device("phone"));
    await settle({ urgent: "push", other: "push" });

    await write("Thanks");

    expect(pushed).toEqual([]);
    expect(await pushJobs()).toEqual([]);
  });

  it(
    "deletes a device its push service says is gone (404 or 410), without a retry",
    timeout,
    async () => {
      const { client, write, checkIn, settle, pushed, gone, subscribed, pushJobs } =
        await checkingIn("Any news?");
      await client.notifications.push.subscribe(device("old-phone"));
      await client.notifications.push.subscribe(device("laptop"));
      await settle({ other: "push" });
      gone.add(device("old-phone").endpoint);

      await write("Remind me later");
      await checkIn();

      expect(pushed.map((one) => one.subscription.endpoint)).toEqual([device("laptop").endpoint]);
      expect(await subscribed()).toEqual([device("laptop").endpoint]);
      expect(await pushJobs()).toEqual([expect.objectContaining({ status: "succeeded" })]);
    },
  );

  it("is retried when a push service refuses it, and keeps the device", timeout, async () => {
    const { client, write, checkIn, settle, failing, subscribed, pushJobs } =
      await checkingIn("Any news?");
    await client.notifications.push.subscribe(device("phone"));
    await settle({ other: "push" });
    failing.add(device("phone").endpoint);

    await write("Remind me later");
    await checkIn();

    expect(await subscribed()).toEqual([device("phone").endpoint]);
    expect(await pushJobs()).toEqual([expect.objectContaining({ status: "queued", attempts: 1 })]);
  });
});
