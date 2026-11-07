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
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { answers, autoSource, promoteAutoTopic } from "@ai-chat/test-support/test-customer";
import { fakeEmailProvider } from "@botsdk/testing/fake-channel";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { representative } from "../src";
import { heldAccountChannel } from "../src/server/channel-accounts";
import { storeReply } from "../src/server/customers";
import {
  representativeCustomerIdentity,
  representativeOutboundDecision,
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
async function world({
  withEmail = true,
  replying = false,
  verifying = false,
}: { withEmail?: boolean; replying?: boolean; verifying?: boolean } = {}) {
  // A replying Representative answers each Customer message, then stops.
  const fake = createFakeAdapter({
    rounds: verifying
      ? [round(toolCall({ name: "verify_customer", input: {}, id: "verify" })), round(), round()]
      : replying
        ? [answers(), round(), answers(), round(), answers(), round()]
        : [round(), round(), round()],
  });
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
      channels: [emailChannel({ provider: email.provider, domain, appUrl: "http://localhost" })],
    }),
    users: { verifiedEmail: async (userId) => (userId === user.id ? ownerEmail : null) },
    features: [representative({ linkUrl: "http://localhost/api/chat" })],
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
  await rpc.representative.updateDraft({
    id,
    draft: {
      jobText: "Answer questions.",
      model,
      ...(replying && { tools: ["reply"] }),
      ...(verifying && { tools: ["verify_customer"] }),
    },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  if (replying) await promoteAutoTopic(id);

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

  /** A reply the business starts on the Customer's thread (so not an answer), as the gate sees it at `now`. */
  const startReply = async (now: Date) => {
    const feature = deps.parts.features.find(({ feature }) => feature.id === "representative")!;
    const [thread] = await getTestDb()
      .select({ id: representativeThread.id })
      .from(representativeThread)
      .where(eq(representativeThread.representativeId, id));
    return getTestDb().transaction((tx) =>
      storeReply(
        { ...feature.context, channel: heldAccountChannel(feature.context) },
        tx,
        {
          threadId: thread!.id,
          upTo: 1,
          heard: { channel: "email", externalId: sender },
          verified: false,
          businessStarted: true,
        },
        { text: "Still here", sources: [autoSource], topic: "general" },
        "small_talk",
        now,
      ),
    );
  };
  const decisions = () =>
    getTestDb()
      .select({
        outcome: representativeOutboundDecision.outcome,
        rule: representativeOutboundDecision.rule,
      })
      .from(representativeOutboundDecision)
      .orderBy(asc(representativeOutboundDecision.createdAt));

  return {
    deps,
    rpc,
    user,
    id,
    fake,
    email,
    chat,
    timer,
    deliver,
    turnRuns,
    startReply,
    decisions,
  };
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

  it("leaves a stranger's mail sent to both to the Representative", async () => {
    const { deps, rpc, user, id, deliver, turnRuns } = await world();
    const { id: botId } = await deps.bots.create({ userId: user.id, name: "Ada", model });
    const bots = (await rpc.channels.email.address({ botId })).address;
    const { address } = (await rpc.representative.emailAddressGet({ id }))!;

    expect((await deliver(bots, { to: [bots, address] })).status).toBe(202);
    await turnRuns(1);

    expect(await customerMessagesOf(id)).toHaveLength(1);
    expect(await identitiesOf(user.id)).toEqual([{ channel: "email", externalId: sender }]);
  });
});

describe("a Representative's reply to an email Customer", () => {
  it("goes out by email from the Representative's address in the Customer's subject thread", async () => {
    const { rpc, id, email, deliver, turnRuns } = await world({ replying: true });
    const { address } = (await rpc.representative.emailAddressGet({ id }))!;

    await deliver(address, { messageId: "<first@mail.example>", subject: "Opening hours" });
    await turnRuns(2);
    await expect.poll(() => email.sent.length, poll).toBe(1);

    expect(email.sent[0]).toMatchObject({
      from: `"Front Désk" <${address}>`,
      to: sender,
      subject: "Re: Opening hours",
      text: expect.stringContaining("Noted."),
      inReplyTo: "<first@mail.example>",
      references: ["<first@mail.example>"],
    });
    expect(email.sent[0]!.messageId).toMatch(/^<[^<>s]+@reps.example>$/);
  });

  it("carries the full References chain on the next reply, and the Customer's answer lands on the same thread", async () => {
    const { rpc, id, email, deliver, turnRuns } = await world({ replying: true });
    const { address } = (await rpc.representative.emailAddressGet({ id }))!;

    await deliver(address, { messageId: "<first@mail.example>", subject: "Opening hours" });
    await turnRuns(2);
    await expect.poll(() => email.sent.length, poll).toBe(1);
    const ours = email.sent[0]!.messageId;

    await deliver(address, {
      messageId: "<second@mail.example>",
      subject: "Re: Opening hours",
      text: "And on Monday?",
      headers: { "In-Reply-To": ours, References: `<first@mail.example> ${ours}` },
    });
    await turnRuns(4);
    await expect.poll(() => email.sent.length, poll).toBe(2);

    expect(email.sent[1]).toMatchObject({
      subject: "Re: Opening hours",
      inReplyTo: "<second@mail.example>",
      references: ["<first@mail.example>", ours, "<second@mail.example>"],
    });
    const threads = await getTestDb()
      .select({ id: representativeThread.id })
      .from(representativeThread)
      .where(eq(representativeThread.representativeId, id));
    expect(threads).toHaveLength(1);
    expect(await customerMessagesOf(id)).toHaveLength(2);
  });

  it("is still sent when the Customer's mail names hundreds of earlier mails", async () => {
    const { rpc, id, email, deliver, turnRuns } = await world({ replying: true });
    const { address } = (await rpc.representative.emailAddressGet({ id }))!;
    const many = Array.from({ length: 300 }, (_, index) => `<m${index}@mail.example>`);

    await deliver(address, { headers: { References: many.join(" ") } });
    await turnRuns(2);
    await expect.poll(() => email.sent.length, poll).toBe(1);

    expect(email.sent[0]!.references).toHaveLength(50);
    expect(email.sent[0]!.references!.at(-1)).toBe("<first@mail.example>");
  });

  it("holds what the business starts at night, and sends the same by day", async () => {
    const { rpc, id, email, deliver, turnRuns, startReply, decisions } = await world({
      replying: true,
    });
    const { address } = (await rpc.representative.emailAddressGet({ id }))!;
    await deliver(address);
    await turnRuns(2);
    await expect.poll(() => email.sent.length, poll).toBe(1);

    const held = await startReply(new Date("2026-10-22T23:00:00.000Z"));

    expect(held).toMatchObject({ error: expect.stringContaining("held") });
    expect(email.sent).toHaveLength(1);
    expect(await decisions()).toContainEqual({ outcome: "hold", rule: "quietHours" });

    await startReply(new Date("2026-10-22T09:00:00.000Z"));
    await expect.poll(() => email.sent.length, poll).toBe(2);
  });

  it("holds the sixth message in a row, by the caps", async () => {
    const { rpc, id, email, deliver, turnRuns, startReply, decisions } = await world({
      replying: true,
    });
    const { address } = (await rpc.representative.emailAddressGet({ id }))!;
    await deliver(address);
    await turnRuns(2);
    await expect.poll(() => email.sent.length, poll).toBe(1);

    const day = new Date("2026-10-22T09:00:00.000Z");
    for (let each = 0; each < 4; each += 1) await startReply(day);
    const sixth = await startReply(day);

    expect(sixth).toMatchObject({ error: expect.stringContaining("held") });
    await expect.poll(() => email.sent.length, poll).toBe(5);
    expect(await decisions()).toContainEqual({ outcome: "hold", rule: "caps" });
  });

  it("declares that email can start a conversation and has no reply window", async () => {
    const { deps } = await world();

    expect(deps.channels.reach("email")).toEqual({ canStartConversation: true });
    // A Channel the Host lacks declares nothing.
    expect(deps.channels.reach("sms")).toBeUndefined();
  });
});

describe("a Customer unsubscribing from a Representative's email", () => {
  /** A Customer who has been answered once, and the link in the answer. */
  async function answered() {
    const w = await world({ replying: true });
    const { address } = (await w.rpc.representative.emailAddressGet({ id: w.id }))!;
    await w.deliver(address);
    await w.turnRuns(2);
    await expect.poll(() => w.email.sent.length, poll).toBe(1);
    const mail = w.email.sent[0]!;
    const url = /<(http:\/\/localhost[^>]+)>/.exec(mail.headers?.["List-Unsubscribe"] ?? "")?.[1];
    const path = url ? new URL(url).pathname : "/missing";
    const request = (method: string, to = path, body?: string) =>
      w.chat.fetch(new Request(`http://localhost${to}`, { method, body }));
    const optedOut = async () => {
      const [row] = await getTestDb()
        .select({ at: representativeCustomerIdentity.optedOutAt })
        .from(representativeCustomerIdentity)
        .where(eq(representativeCustomerIdentity.externalId, sender));
      return row?.at ?? null;
    };
    return { ...w, mail, url, path, request, optedOut };
  }

  it("is offered by headers and a footer link on every mail, both to one signed link", async () => {
    const { mail, url } = await answered();

    expect(url).toMatch(/^http:\/\/localhost\/api\/chat\/representative\/unsubscribe\/.+/);
    expect(mail.headers).toEqual({
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(mail.text).toContain(`Unsubscribe: ${url}`);
  });

  it("opts the identity out on a one-click POST, and the gate then blocks later replies", async () => {
    const { request, optedOut, startReply, decisions, email } = await answered();

    const response = await request("POST", undefined, "List-Unsubscribe=One-Click");

    expect(response.status).toBe(200);
    expect(await optedOut()).not.toBeNull();
    const refused = await startReply(at);
    expect(refused).toMatchObject({ error: expect.any(String) });
    expect(await decisions()).toContainEqual({ outcome: "drop", rule: "optedOut" });
    // The one confirmation, sent through the gate, and nothing after it.
    await expect.poll(() => email.sent.length, poll).toBe(2);
    expect(email.sent[1]!.text).toContain("You won't get any more messages");
  });

  it("only asks on opening the link: a mail scanner's GET opts nobody out", async () => {
    const { request, optedOut } = await answered();

    const response = await request("GET");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<form");
    expect(await optedOut()).toBeNull();
  });

  it("opts out nobody on a forged or altered token", async () => {
    const { request, optedOut, path } = await answered();
    const [identityId, representativeId, signature] = path.split("/").at(-1)!.split(".");
    const base = "/api/chat/representative/unsubscribe/";
    const forged = [
      `${base}${identityId}.${representativeId}.${signature!.slice(0, -2)}AA`,
      `${base}${identityId}.${uuidv7()}.${signature}`,
      `${base}${uuidv7()}.${representativeId}.${signature}`,
      `${base}${identityId}.${representativeId}`,
      `${base}${identityId}.${representativeId}.${signature}.x`,
      `${base}nonsense`,
    ];

    for (const to of forged) expect((await request("POST", to)).status).toBe(410);
    expect(await optedOut()).toBeNull();
  });
});

describe("a code a web chat visitor asked for by email (#1350)", () => {
  it("is emailed from the Representative's address to the identity on record, as a Customer email", async () => {
    const { deps, rpc, id, email } = await world();
    const address = (await rpc.representative.emailAddressGet({ id }))!.address;
    await rpc.representative.customerCreate({ channel: "email", externalId: sender });
    const feature = deps.parts.features.find(({ feature }) => feature.id === "representative")!;
    const channel = heldAccountChannel(feature.context, { linkUrl: "http://localhost/api/chat" });

    // A code from anywhere but the chat window goes nowhere by email.
    await channel.sendProof(
      { channel: "email", externalId: sender },
      { kind: "code", secret: "111111" },
      { representativeId: id },
    );
    await channel.sendProof(
      { channel: "email", externalId: sender },
      { kind: "code", secret: "482913" },
      { representativeId: id, chatWindow: true },
    );

    expect(email.sent).toHaveLength(1);
    const [mail] = email.sent;
    expect(mail!.to).toBe(sender);
    expect(mail!.from).toContain(address);
    expect(mail!.subject).toBe("Your code for Front Désk");
    expect(mail!.text).toContain("Your code is 482913. Enter it in the chat window");
    expect(mail!.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("a signed link to an email Customer", () => {
  const linkOf = (text: string) =>
    /http:\/\/localhost\/api\/chat\/representative\/verify\/\S+/.exec(text)![0];
  const verifiedAt = async (userId: string) =>
    (
      await getTestDb()
        .select({ at: representativeCustomerIdentity.verifiedContactAt })
        .from(representativeCustomerIdentity)
        .where(eq(representativeCustomerIdentity.userId, userId))
    )[0]!.at;

  /** An unverified sender's mail, the Turn it starts, and the mail the Representative sends back. */
  async function asked({ memory = false } = {}) {
    const w = await world({ verifying: true });
    const address = (await w.rpc.representative.emailAddressGet({ id: w.id }))!.address;
    if (memory) {
      const customer = await w.rpc.representative.customerCreate({
        channel: "email",
        externalId: sender,
      });
      await w.rpc.representative.customerProfileSet({
        id: customer.id,
        field: "address",
        value: "12 Mill Lane",
      });
    }
    await w.deliver(address, {
      authentication: { spf: "none", dkim: "none", dmarc: "none", dmarcPolicy: "none" },
    });
    await w.turnRuns(2);
    await expect.poll(() => w.email.sent.length, poll).toBe(1);
    return { ...w, address, mail: w.email.sent[0]! };
  }

  it("is emailed from the Representative's address, and only a click on it verifies", async () => {
    const { deps, user, address, mail } = await asked();
    expect(mail.to).toBe(sender);
    expect(mail.from).toContain(address);
    // A proof mail is a Customer email too (ticket #1349).
    expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail.text).toContain("/representative/unsubscribe/");
    expect(await verifiedAt(user.id)).toBeNull();

    const chat = createTestChat({ deps });
    const url = linkOf(mail.text);
    expect((await chat.fetch(new Request(url))).status).toBe(200);
    expect(await verifiedAt(user.id)).toBeNull();

    expect((await chat.fetch(new Request(url, { method: "POST" }))).status).toBe(200);
    expect(await verifiedAt(user.id)).not.toBeNull();
  });

  it("gives the Customer's memory only after the link is used", async () => {
    const w = await asked({ memory: true });
    const url = linkOf(w.mail.text);
    // The first Turn, before the link: memory stays out of its prompt.
    expect(w.fake.calls.map(promptOf).join()).not.toContain("12 Mill Lane");

    const chat = createTestChat({ deps: w.deps });
    expect((await chat.fetch(new Request(url, { method: "POST" }))).status).toBe(200);
    await w.deliver(w.address, { messageId: "<second@mail.example>", text: "And Monday?" });
    await w.turnRuns(3);

    expect(promptOf(w.fake.calls[2])).toContain("And Monday?");
    expect(promptOf(w.fake.calls[2])).toContain("12 Mill Lane");
  });

  it("works once", async () => {
    const { deps, mail } = await asked();
    const chat = createTestChat({ deps });
    const url = linkOf(mail.text);

    expect((await chat.fetch(new Request(url, { method: "POST" }))).status).toBe(200);
    expect((await chat.fetch(new Request(url, { method: "POST" }))).status).toBe(410);
  });

  it("expires", async () => {
    const { deps, user, mail, timer } = await asked();
    timer.advance(61 * 60_000);

    const opened = await createTestChat({ deps }).fetch(
      new Request(linkOf(mail.text), { method: "POST" }),
    );
    expect(opened.status).toBe(410);
    expect(await verifiedAt(user.id)).toBeNull();
  });
});
