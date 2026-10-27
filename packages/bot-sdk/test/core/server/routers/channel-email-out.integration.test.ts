import { asc, eq, like } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botTurn, job } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { fakeEmailProvider } from "../../../../plugins/channel/fake/index";
import { emailChannel, type OutboundMail } from "@botsdk/bot/channel";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner, claimJob } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { fakeJobClock } from "../../../support/jobs";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const domain = "bots.example";
const appUrl = "https://app.example";
const ownerEmail = "ada.owner@example.com";
const at = new Date("2026-10-22T09:00:00.000Z");

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const says = (text: string, more: Record<string, unknown> = {}, endTurn = true) =>
  toolCall({ name: "send_to_user", input: { text, endTurn, ...more } });

const setsCheckIn = (minutes: number) =>
  toolCall({
    name: "set_check_in",
    input: { at: new Date(at.getTime() + minutes * 60_000).toISOString(), note: "Follow up" },
  });

/**
 * A Bot named "Ada Lovelace" whose Model plays `rounds`, with the email Channel over the fake
 * provider (`send` replaces the provider's send), on an idle runner and a fixed clock. `runDue()`
 * runs every job due until none is left.
 */
async function emailBot(
  rounds: Round[],
  { send }: { send?: (mail: OutboundMail, sent: OutboundMail[]) => Promise<void> } = {},
) {
  const timer = fakeJobClock(at);
  const fake = createFakeAdapter({ rounds });
  const email = fakeEmailProvider();
  const provider = send
    ? { ...email.provider, send: (mail: OutboundMail) => send(mail, email.sent) }
    : email.provider;
  const logged: string[] = [];
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
    channels: [emailChannel({ provider, domain, appUrl })],
    users: { verifiedEmail: async (userId) => (userId === user.id ? ownerEmail : null) },
    jobs,
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    logger: { error: (text: unknown) => void logged.push(String(text)) },
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

  /** Runs the jobs due now, one at a time; `limit` stops after that many. */
  const runDue = async (limit = Infinity) => {
    for (let ran = 0; ran < limit; ran++) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  /** Mails the Bot from its owner. */
  const inbound = async (messageId: string, fields: { subject?: string; text?: string } = {}) => {
    const parsed = await email.provider.parseInbound(
      email.request({
        from: `Ada <${ownerEmail}>`,
        to: [address],
        messageId: `<${messageId}>`,
        subject: fields.subject ?? "Plans",
        text: fields.text ?? "Book me a table for Friday",
        authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
      }),
    );
    if ("rejected" in parsed) throw new Error(parsed.rejected);
    await deps!.channels.receive("email", parsed);
  };
  /** Mails the Bot from its owner, then runs the Turn it starts. */
  const mail = async (messageId: string, fields: { subject?: string; text?: string } = {}) => {
    await inbound(messageId, fields);
    timer.advance(3_000);
    await runDue();
  };
  /** Sends the Bot a web Message, then runs the Turn it starts. */
  const write = async (text: string) => {
    await client.bots.send({ botId, id: uuidv7(), text });
    timer.advance(3_000);
    await runDue();
  };
  const assistantMessages = async () =>
    (await client.bots.get({ botId })).messages.filter((entry) => entry.role === "assistant");
  const deliveryJobs = () =>
    getTestDb()
      .select({ key: job.idempotencyKey, status: job.status, attempts: job.attempts })
      .from(job)
      .where(like(job.idempotencyKey, "channel.deliver:%"))
      .orderBy(asc(job.createdAt), asc(job.id));

  return {
    fake,
    deps,
    client,
    user,
    botId,
    address,
    timer,
    sent: email.sent,
    logged,
    runDue,
    inbound,
    mail,
    write,
    assistantMessages,
    deliveryJobs,
  };
}

describe("where a Bot's reply goes", () => {
  it("emails each Message of a Turn that took an email, threaded, and marks it emailed", async () => {
    const { mail, sent, address, assistantMessages, deliveryJobs } = await emailBot([
      round(says("On it.", {}, false)),
      round(says("Booked for 7pm.")),
    ]);

    await mail("first@mail.example");

    const [first, second] = await assistantMessages();
    expect(first).toMatchObject({ text: "On it.", channel: "email" });
    expect(second).toMatchObject({ text: "Booked for 7pm.", channel: "email" });
    // One clock tick saves both Messages and enqueues both jobs, so they may run in either order.
    expect(await deliveryJobs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: `channel.deliver:${first!.id}:email`, status: "succeeded" }),
        expect.objectContaining({
          key: `channel.deliver:${second!.id}:email`,
          status: "succeeded",
        }),
      ]),
    );
    expect(sent).toHaveLength(2);
    const mailOf = (id: string) => sent.find((one) => one.messageId === `<${id}@${domain}>`);
    expect(mailOf(first!.id)).toMatchObject({
      from: `"Ada Lovelace" <${address}>`,
      to: ownerEmail,
      subject: "Re: Plans",
      messageId: `<${first!.id}@${domain}>`,
      inReplyTo: "<first@mail.example>",
      references: ["<first@mail.example>"],
    });
    expect(mailOf(first!.id)!.text).toContain("On it.");
    // The latest mail in the thread is now the Bot's first.
    expect(mailOf(second!.id)).toMatchObject({
      subject: "Re: Plans",
      messageId: `<${second!.id}@${domain}>`,
      inReplyTo: `<${first!.id}@${domain}>`,
      references: [`<${first!.id}@${domain}>`],
    });
  });

  it("answers a reply's subject without stacking Re:, and an empty one with the Bot's name", async () => {
    const { mail, sent } = await emailBot([round(says("Done.")), round(says("Done again."))]);

    await mail("reply@mail.example", { subject: "RE: Re: Plans" });
    await mail("blank@mail.example", { subject: "" });

    expect(sent.map((one) => one.subject)).toEqual(["Re: Plans", "Re: Ada Lovelace"]);
  });

  it("sends nothing for a web Message's Turn", async () => {
    const { write, sent, assistantMessages, deliveryJobs } = await emailBot([round(says("Hi."))]);

    await write("hello");

    const [reply] = await assistantMessages();
    expect(reply).toMatchObject({ text: "Hi." });
    expect(reply).not.toHaveProperty("channel");
    expect(await deliveryJobs()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("emails a Bot-initiated Message when the user last wrote by email, under the Bot's name", async () => {
    const { mail, timer, runDue, sent, assistantMessages } = await emailBot([
      round(setsCheckIn(60)),
      round(says("I'll check back in an hour.")),
      round(says("Checking in: did they reply?")),
    ]);

    await mail("first@mail.example");
    timer.advance(60 * 60_000);
    await runDue();
    timer.advance(3_000);
    await runDue();

    const messages = await assistantMessages();
    expect(messages.map((entry) => entry.channel)).toEqual(["email", "email"]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      subject: "Ada Lovelace",
      inReplyTo: `<${messages[0]!.id}@${domain}>`,
    });
  });

  it("keeps a Bot-initiated Message in web when the user last wrote from web", async () => {
    const { mail, write, timer, runDue, sent, assistantMessages } = await emailBot([
      round(setsCheckIn(60)),
      round(says("I'll check back in an hour.")),
      round(says("Noted.")),
      round(says("Checking in: did they reply?")),
    ]);

    await mail("first@mail.example");
    await write("Also, no rush.");
    timer.advance(60 * 60_000);
    await runDue();
    timer.advance(3_000);
    await runDue();

    expect((await assistantMessages()).map((entry) => entry.channel)).toEqual([
      "email",
      undefined,
      undefined,
    ]);
    expect(sent).toHaveLength(1);
  });

  it("sends no email for a reaction, which makes no Message", async () => {
    const rounds: Round[] = [];
    const { inbound, timer, runDue, client, botId, sent, deliveryJobs } = await emailBot(rounds);

    await inbound("thanks@mail.example", { text: "thanks!" });
    const [thanks] = (await client.bots.get({ botId })).messages;
    rounds.push(round(says("", { react: { messageId: thanks!.id, emoji: "👍" } })));
    timer.advance(3_000);
    await runDue();

    const [reacted] = (await client.bots.get({ botId })).messages;
    expect(reacted!.reactions?.bot?.emoji).toBe("👍");
    expect(await deliveryJobs()).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("the channel's view of the next Bot-initiated Message", () => {
  it("names the Channel the user last wrote from", async () => {
    const { client, botId, mail, write } = await emailBot([round(says("A.")), round(says("B."))]);

    expect((await client.channels.email.address({ botId })).nextChannel).toBe("web");
    await mail("first@mail.example");
    expect((await client.channels.email.address({ botId })).nextChannel).toBe("email");
    await write("from the app");
    expect((await client.channels.email.address({ botId })).nextChannel).toBe("web");
  });
});

describe("degraded controls", () => {
  it("emails a choice as a numbered list with a link to answer in web", async () => {
    const { mail, sent, botId } = await emailBot([
      round(says("Which time?", { choice: { options: ["7pm", "8pm"], other: true } })),
    ]);

    await mail("first@mail.example");

    expect(sent[0]!.text).toBe(
      [
        "Which time?",
        "",
        "1. 7pm",
        "2. 8pm",
        "3. Other: reply with your own answer",
        "",
        `Answer in the app: ${appUrl}/bots/${botId}`,
      ].join("\n"),
    );
    expect(sent[0]!.html).toContain("<ol>");
    expect(sent[0]!.html).toContain(`href="${appUrl}/bots/${botId}"`);
  });

  it("emails a Secret request as a link only, never a way to answer by mail", async () => {
    const { mail, sent, botId } = await emailBot([
      round(says("I need your token.", { secret: { name: "GITHUB_TOKEN", why: "To push." } })),
    ]);

    await mail("first@mail.example");

    expect(sent[0]!.text).toBe(
      ["I need your token.", "", `Enter it securely in the app: ${appUrl}/bots/${botId}`].join(
        "\n",
      ),
    );
  });
});

describe("delivery failures", () => {
  it("never holds the Turn: the Turn ends while its email waits in its own job", async () => {
    const { inbound, botId, timer, runDue, sent, deliveryJobs, client } = await emailBot(
      [round(says("Done."))],
      { send: () => new Promise(() => {}) },
    );
    await inbound("first@mail.example");
    timer.advance(3_000);

    await runDue(1);

    const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
    expect(turn!.status).toBe("complete");
    expect(await deliveryJobs()).toEqual([expect.objectContaining({ status: "queued" })]);
    expect(sent).toEqual([]);
    expect((await client.bots.get({ botId })).messages.at(-1)).toMatchObject({ channel: "email" });
  });

  it("retries a failed send, and sends once it goes through", async () => {
    let failures = 1;
    const { mail, timer, runDue, sent, deliveryJobs } = await emailBot([round(says("Done."))], {
      send: async (one, kept) => {
        if (failures-- > 0) throw new Error("SMTP is down");
        kept.push(one);
      },
    });

    await mail("first@mail.example");
    expect(sent).toEqual([]);
    timer.advance(60_000);
    await runDue();

    expect(sent).toHaveLength(1);
    expect(await deliveryJobs()).toEqual([
      expect.objectContaining({ status: "succeeded", attempts: 2 }),
    ]);
  });

  it("gives up after the runner's retries and logs it", async () => {
    const { mail, timer, runDue, sent, logged, deliveryJobs } = await emailBot(
      [round(says("Done."))],
      {
        send: async () => {
          throw new Error("SMTP is down");
        },
      },
    );

    await mail("first@mail.example");
    for (let attempt = 0; attempt < 3; attempt++) {
      timer.advance(10 * 60_000);
      await runDue();
    }

    expect(sent).toEqual([]);
    expect(await deliveryJobs()).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(logged.filter((line) => line.includes("Couldn't email"))).toHaveLength(1);
  });
});
