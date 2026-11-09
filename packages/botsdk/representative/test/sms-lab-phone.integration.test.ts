import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { saveCredentials } from "@botsdk/bot/models/internal";
import type { BotSdkPlugin } from "@botsdk/bot/plugin";
import { inProcessRunner } from "@botsdk/bot/runner/internal";
import { channelAccount, job } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc, createTestChat } from "@ai-chat/test-support/sdk";
import { promoteAutoTopic } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startLabPhone, type LabPhone } from "../../channel-sms/lab-phone/lab-phone";
import { sms } from "../../channel-sms/src";
import { connectChannelAccount } from "../src/server/channel-accounts";
import { representativeCustomerIdentity } from "../src/server/db/schema";
import { representativeFeature } from "../src/server/plugin";

/*
 * SMS end to end (#1174 review): a text typed on the lab phone reaches a Representative through the
 * real Telnyx adapter and the Host's webhook route, signature and number included, and the code the
 * Model asks for goes back to the sender's number through the lab phone's `/v2/messages`.
 */

vi.setConfig({ testTimeout: 30_000 });

const poll = { timeout: 10_000 };
const silent = { error: () => {} };
const model = "openai:gpt-6-luna";
// 09:00 UTC: outside a Representative's default quiet hours.
const at = new Date("2026-10-22T09:00:00.000Z");
const line = "+15550001111";
const customer = "+15550002222";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Serves `handle` on 127.0.0.1, so the lab phone can post to it as Telnyx would to the Host. */
async function serve(handle: (request: Request) => Promise<Response>): Promise<string> {
  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method,
        headers: new Headers(incoming.headers as Record<string, string>),
        body: Buffer.concat(chunks),
      });
      void handle(request).then(async (response) => {
        outgoing.writeHead(response.status).end(Buffer.from(await response.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A Representative on an SMS account at the lab phone, whose Model asks to verify, then is done. */
async function world(): Promise<{
  phone: LabPhone;
  texts: (from: string, to: string, text: string) => Promise<void>;
}> {
  const phone = await startLabPhone({ seed: "sms-lab-phone-test" });
  cleanups.push(() => phone.close());
  const fake = createFakeAdapter({
    rounds: [
      round(toolCall({ name: "verify_customer", input: {}, id: "verify" })),
      round(),
      round(),
      round(),
    ],
  });
  const timer = fakeJobClock(at);
  let made: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => made!.parts.jobs,
  });
  const deps = createTestSdk({
    jobs,
    channels: [sms({ apiBase: phone.url })],
    features: [representativeFeature()],
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    memory: false,
    fetch: globalThis.fetch,
  });
  made = deps;
  await jobs.start();
  cleanups.push(() => jobs.stop());
  const part: BotSdkPlugin = deps.parts.all.find((one) => one.id === "channel")!;
  await part.start!(deps);
  cleanups.push(() => part.stop!(deps));

  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const context = deps.parts.features.find(
    ({ feature }) => feature.id === "representative",
  )!.context;
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply", "verify_customer"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  await promoteAutoTopic(id);
  await connectChannelAccount(context, {
    userId: user.id,
    representativeId: id,
    platform: "sms",
    credentials: { apiKey: "ANY", publicKey: phone.publicKey, number: line },
  });
  const [account] = await getTestDb()
    .select({ id: channelAccount.id })
    .from(channelAccount)
    .where(eq(channelAccount.platformBotId, line));

  const host = await serve(createTestChat({ deps }).fetch);
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    redirect: "manual" as const,
  });
  await fetch(
    `${phone.url}/webhook-url`,
    form({ url: `${host}/api/chat/channels/sms/${account!.id}` }),
  );

  return {
    phone,
    /** Types `text` on the lab phone, from `from` to `to`, and lets the Turn a text to the line starts run. */
    texts: async (from, to, text) => {
      const before = await jobCount();
      expect((await fetch(`${phone.url}/receive`, form({ from, to, text }))).status).toBe(303);
      if (to !== line) return;
      // The route answers before it hands the text in, so the Turn's wait starts only once its job is
      // queued (a code reply stores no message).
      await expect.poll(jobCount, poll).toBeGreaterThan(before);
      timer.advance(batchLongestMs);
      timer.tick();
    },
  };
}

const jobCount = async () => (await getTestDb().select({ id: job.id }).from(job)).length;

const sentTo = (phone: LabPhone, to: string) =>
  phone.texts.filter((text) => text.direction === "out" && text.to === to);

const identities = () =>
  getTestDb()
    .select({
      externalId: representativeCustomerIdentity.externalId,
      verifiedContactAt: representativeCustomerIdentity.verifiedContactAt,
    })
    .from(representativeCustomerIdentity);

describe("SMS through the lab phone, the real adapter and the webhook route", () => {
  it("makes a stranger a Customer and texts the code they ask for back to their number", async () => {
    const { phone, texts } = await world();

    await texts(customer, line, "It is me, Ada");

    await expect.poll(() => sentTo(phone, customer).length, poll).toBe(1);
    const [code] = sentTo(phone, customer);
    expect(code).toMatchObject({ from: line, text: expect.stringMatching(/\b\d{6}\b/) });
    expect(await identities()).toEqual([{ externalId: customer, verifiedContactAt: null }]);

    await texts(customer, line, `here: ${/\b\d{6}\b/.exec(code!.text)![0]}`);

    await expect.poll(async () => (await identities())[0]?.verifiedContactAt, poll).not.toBeNull();
  });

  it("takes no text sent to another number", async () => {
    const { phone, texts } = await world();

    await texts(customer, "+15550009999", "Hello?");

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(phone.texts.filter((text) => text.direction === "out")).toEqual([]);
    expect(await identities()).toEqual([]);
  });
});
