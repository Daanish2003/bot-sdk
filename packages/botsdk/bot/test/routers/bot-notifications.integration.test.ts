import type { NotificationSettings } from "@botsdk/client/bot/notifications";
import { afterEach, describe, expect, it } from "vitest";

import { uuidv7 } from "../../src/lib/uuidv7";
import { fakeEmailProvider } from "@botsdk/testing/fake-channel";
import { emailChannel } from "../../src/channel";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner, claimJob } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";

/*
 * Notification settings (spec #1024): Quiet hours and where Messages from Turns the user didn't
 * start go, through the email Channel and the fake provider.
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
 * A Bot whose Model plays `rounds`, with the email Channel over the fake provider, on an idle runner
 * and a fixed clock.
 */
async function notifiedBot(rounds: Round[]) {
  const timer = fakeJobClock(at);
  const fake = createFakeAdapter({ rounds });
  const email = fakeEmailProvider();
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
    channels: [emailChannel({ provider: email.provider, domain, appUrl })],
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
  const { address } = await client.channels.email.address({ botId });

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  /** Mails the Bot from its owner, then runs the Turn it starts. */
  const mail = async (messageId: string) => {
    const parsed = await email.provider.parseInbound(
      email.request({
        from: `Ada <${ownerEmail}>`,
        to: [address],
        messageId: `<${messageId}>`,
        subject: "Plans",
        text: "Book me a table for Friday",
        authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
      }),
    );
    if ("rejected" in parsed) throw new Error(parsed.rejected);
    await deps!.channels.receive("email", parsed);
    timer.advance(3_000);
    await runDue();
  };
  /**
   * Sends the Bot (or Bot `to`) a web Message, from `timeZone` when given, then runs the Turn it
   * starts.
   */
  const write = async (text: string, timeZone?: string, to = botId) => {
    await client.bots.send({ botId: to, id: uuidv7(), text, ...(timeZone && { timeZone }) });
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

  return {
    client,
    deps,
    botId,
    sent: email.sent,
    mail,
    write,
    checkIn,
    assistantMessages,
    settle,
  };
}

/** A Bot that sets a Check-in, then says `checkInSays` (with `more`) when it fires. */
const checkingIn = (checkInSays: string, more: Record<string, unknown> = {}) =>
  notifiedBot([
    round(setsCheckIn(60)),
    round(says("I'll check back in an hour.")),
    round(says(checkInSays, more)),
  ]);

describe("the notification settings API", () => {
  it("reads the defaults for a user who has set nothing", timeout, async () => {
    const { client } = await notifiedBot([]);

    expect(await client.notifications.get()).toEqual({
      quietHours: null,
      urgent: null,
      other: null,
    });
  });

  it("saves the signed-in user's settings, which no other user sees", timeout, async () => {
    const { client, deps } = await notifiedBot([]);
    const settings = { quietHours: night, urgent: "email", other: "in_app" } as const;

    expect(await client.notifications.update(settings)).toEqual(settings);
    expect(await client.notifications.get()).toEqual(settings);
    const other = chatRpc({ user: await insertUser(), deps });
    expect(await other.notifications.get()).toEqual({
      quietHours: null,
      urgent: null,
      other: null,
    });

    await client.notifications.update({ quietHours: null, urgent: null, other: "email" });
    expect(await client.notifications.get()).toEqual({
      quietHours: null,
      urgent: null,
      other: "email",
    });
  });

  it(
    "refuses quiet hours that start when they end, or a time that isn't HH:MM",
    timeout,
    async () => {
      const { client } = await notifiedBot([]);

      for (const quietHours of [
        { start: "22:00", end: "22:00" },
        { start: "7:00", end: "22:00" },
        { start: "22:00", end: "24:00" },
      ]) {
        await expect(
          client.notifications.update({ quietHours, urgent: null, other: null }),
        ).rejects.toThrow("Input validation failed");
      }
    },
  );
});

describe("where a Message from a Turn the user didn't start goes", () => {
  it(
    "emails it when the rest go by email, though the user last wrote from web",
    timeout,
    async () => {
      const { write, checkIn, settle, sent, assistantMessages } = await checkingIn("Any news?");
      await settle({ other: "email" });

      await write("Remind me later");
      await checkIn();

      expect((await assistantMessages()).map((entry) => entry.channel)).toEqual([
        undefined,
        "email",
      ]);
      expect(sent.map((one) => one.text.split("\n")[0])).toEqual(["Any news?"]);
    },
  );

  it(
    "keeps it in-app when the rest stay in-app, though the user last wrote by email",
    timeout,
    async () => {
      const { mail, checkIn, settle, sent, assistantMessages } = await checkingIn("Any news?");
      await settle({ other: "in_app" });

      await mail("first@mail.example");
      await checkIn();

      expect((await assistantMessages()).map((entry) => entry.channel)).toEqual([
        "email",
        undefined,
      ]);
      expect(sent).toHaveLength(1);
    },
  );

  it("sends an urgent Message where urgent ones go, apart from the rest", timeout, async () => {
    const { write, checkIn, settle, sent, assistantMessages } = await checkingIn(
      "Your flight is cancelled.",
      { urgent: true },
    );
    await settle({ urgent: "email", other: "in_app" });

    await write("Remind me later");
    await checkIn();

    const [, urgent] = await assistantMessages();
    expect(urgent).toMatchObject({ urgent: true, channel: "email" });
    expect(sent).toHaveLength(1);
  });

  it("is the Channel the email popover names for the next Message", timeout, async () => {
    const { client, botId, mail, write, settle } = await notifiedBot([
      round(says("A.")),
      round(says("B.")),
    ]);
    const next = async () => (await client.channels.email.address({ botId })).nextChannel;

    await write("from the app");
    await settle({ other: "email" });
    expect(await next()).toBe("email");
    await mail("first@mail.example");
    await settle({ other: "in_app" });
    expect(await next()).toBe("web");
  });

  it("is in-app in the email popover during quiet hours", timeout, async () => {
    const { client, botId, write, settle } = await notifiedBot([round(says("A."))]);
    const next = async () => (await client.channels.email.address({ botId })).nextChannel;

    await write("from the app", losAngeles);
    await settle({ quietHours: night, other: "email" });
    expect(await next()).toBe("web");
    await settle({ other: "email" });
    expect(await next()).toBe("email");
  });

  it("falls back to the Channel the user last wrote from on an empty choice", timeout, async () => {
    const { mail, checkIn, settle, sent } = await checkingIn("Your flight is cancelled.", {
      urgent: true,
    });
    await settle({ other: "in_app" });

    await mail("first@mail.example");
    await checkIn();

    expect(sent).toHaveLength(2);
  });
});

describe("quiet hours", () => {
  it(
    "hold back the email in the user's time zone, and keep the Message in the Conversation",
    timeout,
    async () => {
      const { write, checkIn, settle, sent, assistantMessages } = await checkingIn("Any news?");
      await settle({ quietHours: night, other: "email" });

      await write("Remind me later", losAngeles);
      await checkIn();

      const [, held] = await assistantMessages();
      expect(held).toMatchObject({ text: "Any news?" });
      expect(held).not.toHaveProperty("channel");
      expect(sent).toEqual([]);
    },
  );

  it(
    "read the time zone the user last sent, though they wrote by email since",
    timeout,
    async () => {
      const { write, mail, checkIn, settle, sent } = await notifiedBot([
        round(setsCheckIn(60)),
        round(says("I'll check back in an hour.")),
        round(says("Booked.")),
        round(says("Any news?")),
      ]);
      await settle({ quietHours: night, other: "email" });

      await write("Remind me later", losAngeles);
      await mail("first@mail.example");
      await checkIn();

      // Only the reply to the user's email went out; the Check-in's Message was held back.
      expect(sent.map((one) => one.text.split("\n")[0])).toEqual(["Booked."]);
    },
  );

  it("read the time zone the user sent another of their Bots", timeout, async () => {
    const { client, write, checkIn, settle, sent, assistantMessages } = await notifiedBot([
      round(says("Hello.")),
      round(setsCheckIn(60)),
      round(says("I'll check back in an hour.")),
      round(says("Any news?")),
    ]);
    await settle({ quietHours: night, other: "email" });
    const { id: otherBot } = await client.bots.create({ name: "Grace", model });

    await write("Hi", losAngeles, otherBot);
    await write("Remind me later");
    await checkIn();

    expect((await assistantMessages()).at(-1)).toMatchObject({ text: "Any news?" });
    expect(sent).toEqual([]);
  });

  it("don't hold back outside them in the user's time zone", timeout, async () => {
    const { write, checkIn, settle, sent } = await checkingIn("Any news?");
    // 10:00 UTC, the Check-in's time, is outside 22:00 to 07:00 in UTC.
    await settle({ quietHours: night, other: "email" });

    await write("Remind me later");
    await checkIn();

    expect(sent).toHaveLength(1);
  });

  it("let an urgent Message through", timeout, async () => {
    const { write, checkIn, settle, sent, assistantMessages } = await checkingIn(
      "Your flight is cancelled.",
      { urgent: true },
    );
    await settle({ quietHours: night, urgent: "email" });

    await write("Remind me later", losAngeles);
    await checkIn();

    expect((await assistantMessages()).at(-1)).toMatchObject({ channel: "email" });
    expect(sent).toHaveLength(1);
  });
});

describe("a Turn that took a user Trigger", () => {
  it("replies where the user wrote from, whatever the settings say", timeout, async () => {
    const { mail, write, settle, sent, assistantMessages } = await notifiedBot([
      round(says("Booked.")),
      round(says("Noted.")),
    ]);
    await settle({
      quietHours: { start: "00:00", end: "23:59" },
      urgent: "in_app",
      other: "in_app",
    });

    await mail("first@mail.example");
    await settle({ other: "email" });
    await write("Thanks");

    expect((await assistantMessages()).map((entry) => entry.channel)).toEqual(["email", undefined]);
    expect(sent).toHaveLength(1);
  });
});
