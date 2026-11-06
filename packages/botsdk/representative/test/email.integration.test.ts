import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { emailChannel } from "@botsdk/bot/channel";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { botTrigger } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc, createTestChat } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { fakeEmailProvider } from "@botsdk/testing/fake-channel";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { representative } from "../src";
import {
  representativeCustomerIdentity,
  representativeThread,
  representativeThreadMessage,
} from "../src/server/db/schema";

/*
 * A Representative's email address (ticket #1346), through the core's inbound route over
 * `fakeEmailProvider`, with a fake Model on real Postgres: whoever writes to it is a Customer, verified
 * only by an enforcing DMARC pass, while a Bot's address keeps the Bot rule.
 */

vi.setConfig({ testTimeout: 30_000 });

const poll = { timeout: 10_000 };
const silent = { error: () => {} };
const model = "openai:gpt-6-luna";
const domain = "reps.example";
const ownerEmail = "owner@example.com";
const sender = "sam@example.com";
// 09:00 UTC: outside a Representative's default quiet hours.
const at = new Date("2026-10-22T09:00:00.000Z");

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** An instance with the email Channel over the fake provider, and an owner's enabled Representative. */
async function world({ withEmail = true }: { withEmail?: boolean } = {}) {
  const fake = createFakeAdapter({ rounds: [round(), round(), round()] });
  const email = fakeEmailProvider();
  const timer = fakeJobClock(at);
  const user = await insertUser();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    ...(withEmail && {
      channels: [emailChannel({ provider: email.provider, domain, appUrl: "https://app.example" })],
    }),
    users: { verifiedEmail: async (userId) => (userId === user.id ? ownerEmail : null) },
    features: [representative()],
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    memory: false,
  });
  await jobs.start();
  runners.push(jobs);
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front Désk" });
  await rpc.representative.updateDraft({ id, draft: { jobText: "Answer questions.", model } });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });

  // One instance, as a Host has: it remembers the mail it took lately.
  const chat = createTestChat({ deps });
  /** Posts a mail from `sender`, with `mail` overriding any field, as the provider does: signed out. */
  const deliver = (to: string, mail: Parameters<typeof email.request>[0] = {}) =>
    chat.fetch(
      email.request({
        from: `Sam <${sender}>`,
        to: [to],
        messageId: "<first@mail.example>",
        subject: "Opening hours",
        text: "Are you open on Sunday?",
        authentication: { spf: "pass", dkim: "pass", dmarc: "pass", dmarcPolicy: "none" },
        ...mail,
      }),
    );

  /** Lets the Turn a message started run, and waits for its Model call. */
  const turnRuns = async (calls: number) => {
    timer.advance(batchLongestMs);
    timer.tick();
    await expect.poll(() => fake.calls.length, poll).toBe(calls);
  };

  return { deps, rpc, user, id, fake, email, deliver, turnRuns };
}

/** The Customers' messages on Representative `id`'s threads, oldest first. */
const customerMessagesOf = (id: string) =>
  getTestDb()
    .select({
      channel: representativeThreadMessage.channel,
      externalId: representativeThreadMessage.externalId,
      text: representativeThreadMessage.text,
      verified: representativeThreadMessage.verified,
      proofRule: representativeThreadMessage.proofRule,
    })
    .from(representativeThreadMessage)
    .innerJoin(
      representativeThread,
      eq(representativeThread.id, representativeThreadMessage.threadId),
    )
    .where(
      and(
        eq(representativeThread.representativeId, id),
        eq(representativeThreadMessage.author, "customer"),
      ),
    )
    .orderBy(asc(representativeThreadMessage.createdAt), asc(representativeThreadMessage.position));

const identitiesOf = (userId: string) =>
  getTestDb()
    .select({
      channel: representativeCustomerIdentity.channel,
      externalId: representativeCustomerIdentity.externalId,
    })
    .from(representativeCustomerIdentity)
    .where(eq(representativeCustomerIdentity.userId, userId));

const promptOf = (call: { messages: unknown } | undefined) => JSON.stringify(call?.messages ?? []);

describe("a Representative's email address", () => {
  it("is made on the owner's first read, stays, and a rotation replaces it", async () => {
    const { rpc, id } = await world();

    const first = await rpc.representative.emailAddressGet({ id });
    expect(first?.address).toMatch(/^front-desk\.[a-z0-9]{8}@reps\.example$/);
    expect(await rpc.representative.emailAddressGet({ id })).toEqual(first);

    const rotated = await rpc.representative.emailAddressRotate({ id });
    expect(rotated?.address).toMatch(/^front-desk\.[a-z0-9]{8}@reps\.example$/);
    expect(rotated).not.toEqual(first);
    expect(await rpc.representative.emailAddressGet({ id })).toEqual(rotated);
  });

  it("is another owner's to neither read nor rotate", async () => {
    const { deps, id } = await world();
    const stranger = chatRpc({ user: await insertUser(), deps });
    const missing = { data: { code: "error.representativeNotFound" } };

    await expect(stranger.representative.emailAddressGet({ id })).rejects.toMatchObject(missing);
    await expect(stranger.representative.emailAddressRotate({ id })).rejects.toMatchObject(missing);
  });

  it("is null when the Host has no email Channel", async () => {
    const { rpc, id } = await world({ withEmail: false });

    expect(await rpc.representative.emailAddressGet({ id })).toBeNull();
    expect(await rpc.representative.emailAddressRotate({ id })).toBeNull();
  });

  it("stops at once when rotated: mail to the old one reaches nobody", async () => {
    const { rpc, user, id, deliver, turnRuns } = await world();
    const old = (await rpc.representative.emailAddressGet({ id }))!.address;
    const current = (await rpc.representative.emailAddressRotate({ id }))!.address;

    expect((await deliver(old, { messageId: "<old@mail.example>" })).status).toBe(202);
    expect(await identitiesOf(user.id)).toEqual([]);

    await deliver(current.toUpperCase());
    await turnRuns(1);
    expect(await customerMessagesOf(id)).toHaveLength(1);
  });
});

describe("mail to a Representative's address", () => {
  it("from a domain with no enforcing DMARC policy reaches a Customer thread unverified, with no memory in the prompt", async () => {
    const { rpc, user, id, fake, deliver, turnRuns } = await world();
    const { address } = (await rpc.representative.emailAddressGet({ id }))!;
    // The Customer already on record at this address, with memory a verified sender would get.
    const customer = await rpc.representative.customerCreate({
      channel: "email",
      externalId: sender,
    });
    await rpc.representative.customerProfileSet({
      id: customer.id,
      field: "address",
      value: "12 Mill Lane",
    });

    expect((await deliver(address)).status).toBe(202);
    await turnRuns(1);

    expect(await customerMessagesOf(id)).toEqual([
      {
        channel: "email",
        externalId: sender,
        text: "Opening hours\nAre you open on Sunday?",
        verified: false,
        proofRule: "dmarc",
      },
    ]);
    expect(await identitiesOf(user.id)).toEqual([{ channel: "email", externalId: sender }]);
    const prompt = promptOf(fake.calls[0]);
    expect(prompt).toContain("Are you open on Sunday?");
    expect(prompt).not.toContain("12 Mill Lane");
  });

  it("from a domain with an enforcing DMARC pass reaches the thread verified, with its memory", async () => {
    const { rpc, id, fake, deliver, turnRuns } = await world();
    const { address } = (await rpc.representative.emailAddressGet({ id }))!;
    const customer = await rpc.representative.customerCreate({
      channel: "email",
      externalId: sender,
    });
    await rpc.representative.customerProfileSet({
      id: customer.id,
      field: "address",
      value: "12 Mill Lane",
    });

    await deliver(address, {
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass", dmarcPolicy: "quarantine" },
    });
    await turnRuns(1);

    expect(await customerMessagesOf(id)).toMatchObject([{ verified: true }]);
    expect(promptOf(fake.calls[0])).toContain("12 Mill Lane");
  });

  it.each([
    ["a DMARC fail", { spf: "fail", dkim: "fail", dmarc: "fail", dmarcPolicy: "none" }],
    [
      "a DMARC fail on an enforcing domain",
      { spf: "fail", dkim: "fail", dmarc: "fail", dmarcPolicy: "reject" },
    ],
    ["no DMARC verdict", { spf: "none", dkim: "none", dmarc: "none", dmarcPolicy: "none" }],
  ] as const)(
    "with %s still reaches a Customer thread, unverified",
    async (_name, authentication) => {
      const { rpc, id, deliver, turnRuns } = await world();
      const { address } = (await rpc.representative.emailAddressGet({ id }))!;

      await deliver(address, { authentication });
      await turnRuns(1);

      expect(await customerMessagesOf(id)).toMatchObject([{ externalId: sender, verified: false }]);
    },
  );

  it.each([
    ["an automatic reply", { headers: { "Auto-Submitted": "auto-replied" } }],
    ["mail from the Channel's own domain", { from: `someone@${domain}` }],
    ["mail with no Message-ID", { messageId: "" }],
    ["mail with no text", { subject: "", text: "" }],
  ] as const)("is dropped for %s", async (_name, mail) => {
    const { rpc, user, id, deliver } = await world();
    const { address } = (await rpc.representative.emailAddressGet({ id }))!;

    expect((await deliver(address, mail)).status).toBe(202);

    expect(await identitiesOf(user.id)).toEqual([]);
    expect(await customerMessagesOf(id)).toEqual([]);
  });

  it("stores a redelivered mail once", async () => {
    const { rpc, id, deliver, turnRuns } = await world();
    const { address } = (await rpc.representative.emailAddressGet({ id }))!;

    await deliver(address);
    await deliver(address);
    await turnRuns(1);

    expect(await customerMessagesOf(id)).toHaveLength(1);
  });
});

describe("a Bot's address, beside a Representative's", () => {
  it("still drops strangers and the owner's mail without a DMARC pass, and makes no Customer", async () => {
    const { deps, rpc, user, deliver } = await world();
    const { id: botId } = await deps.bots.create({ userId: user.id, name: "Ada", model });
    const { address } = await rpc.channels.email.address({ botId });
    const triggers = () =>
      getTestDb()
        .select({ channel: botTrigger.channel })
        .from(botTrigger)
        .where(eq(botTrigger.botId, botId));
    const unique = () => `<${uuidv7()}@mail.example>`;

    await deliver(address, { messageId: unique(), text: "From a stranger" });
    await deliver(address, {
      from: ownerEmail,
      messageId: unique(),
      text: "Spoofed as the owner",
      authentication: { spf: "fail", dkim: "fail", dmarc: "fail", dmarcPolicy: "none" },
    });

    expect(await identitiesOf(user.id)).toEqual([]);
    expect(await triggers()).toEqual([]);

    // The owner's mail with a pass, even under policy `none` as Mailpit's, still wakes the Bot.
    await deliver(address, { from: ownerEmail, messageId: unique(), text: "From the owner" });
    expect(await triggers()).toEqual([{ channel: "email" }]);
  });
});
