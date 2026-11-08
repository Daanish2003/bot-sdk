import { createMemoryCounters } from "@botsdk/bot/chat/counters";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc, createTestChat } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { findBot } from "../../src/bot/conversation";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import type { BotSdkPlugin } from "../../src/plugin";
import { claimJob, inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { botTrigger, channelAccount, job, linkedIdentity, message } from "../../src/storage";

/*
 * A messaging Channel whose platform only posts to a webhook (ticket #1355): the Host's route for
 * the fake adapter's webhook checks the signature and hands the updates to the same inbound path a
 * listener's take, answering before the work after accepting is done.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const at = new Date("2026-10-22T09:00:00.000Z");
const token = "1:secret";

const started: { jobs: JobRunner; part: BotSdkPlugin; deps: TestDeps }[] = [];

afterEach(async () => {
  for (const { jobs, part, deps } of started.splice(0)) {
    await part.stop!(deps);
    await jobs.stop();
  }
});

/**
 * A Bot whose Channel account is `@bot_1` on the fake webhook platform, its user Linked as platform
 * user `1001`, on an idle runner and a fixed clock. `post` sends a request to the account's route.
 */
async function webhookBot({
  isBlocked,
  counters = createMemoryCounters(),
}: {
  isBlocked?: () => Promise<boolean>;
  counters?: ReturnType<typeof createMemoryCounters>;
} = {}) {
  const timer = fakeJobClock(at);
  const brain = createFakeAdapter({ rounds: [round(), round(), round()] });
  const fake = fakeMessagingAdapter({ webhook: true });
  /** An instance over the test database with the fake platform, as several processes would be. */
  const instance = () => {
    let deps: TestDeps | undefined;
    const jobs = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      drainMs: 50,
      clock: timer.clock,
      jobs: () => deps!.parts.jobs,
    });
    deps = createTestSdk({
      channels: [fake.adapter],
      users: { isBlocked },
      jobs,
      counters,
      adapterFor: () => brain.adapter,
      clock: timer.clock.now,
      logger: silent,
    });
    const part = deps.parts.all.find((candidate) => candidate.id === "channel")!;
    started.push({ jobs, part, deps });
    return deps;
  };
  const deps = instance();
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada Lovelace", model });
  const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
  await client.channels.accounts.save({ botId, platform: "fake", credentials: { token } });
  const [account] = await getTestDb()
    .select({ id: channelAccount.id })
    .from(channelAccount)
    .where(eq(channelAccount.botId, botId));
  await getTestDb().insert(linkedIdentity).values({
    id: uuidv7(),
    userId: user.id,
    platform: "fake",
    platformUserId: "1001",
    handle: "@ada",
    workspaceId: null,
    linkedAt: at,
  });
  const url = `https://host.example/api/chat/channels/fake/${account!.id}`;

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await started[0]!.jobs.runClaimed(claimed);
    }
  };
  return {
    fake,
    brain,
    deps,
    instance,
    conversationId,
    accountId: account!.id,
    url,
    timer,
    runDue,
    /** Posts `request` to the Host's handler over `on` (the first instance by default). */
    post: (request: Request, on: TestDeps = deps) => createTestChat({ deps: on }).fetch(request),
  };
}

const triggersOf = (conversationId: string) =>
  getTestDb()
    .select()
    .from(botTrigger)
    .where(eq(botTrigger.conversationId, conversationId))
    .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id));

const messagesOf = (conversationId: string) =>
  getTestDb().select().from(message).where(eq(message.conversationId, conversationId));

describe("a messaging Channel's webhook route", () => {
  it("takes a signed request from the Linked identity as a Trigger, and the Turn runs", async () => {
    const { fake, brain, conversationId, accountId, url, timer, runDue, post } = await webhookBot();

    const response = await post(
      fake.webhookRequest(url, token, [{ sourceId: "77", text: "Book me a table for Friday" }]),
    );

    expect(response.status).toBe(202);
    await expect.poll(async () => (await triggersOf(conversationId)).length, poll).toBe(1);
    const [trigger] = await triggersOf(conversationId);
    expect(trigger).toMatchObject({ id: `fake:${accountId}:77`, source: "user", channel: "fake" });
    timer.advance(500);
    await runDue();
    expect(brain.calls).toHaveLength(1);
    expect(JSON.stringify(brain.calls[0]!.messages)).toContain("Book me a table for Friday");
  });

  it.each([
    ["a wrong signature", "0".repeat(64)],
    ["no signature", null],
  ])("rejects a request with %s, storing nothing and waking no Turn", async (_name, signature) => {
    const { fake, brain, conversationId, url, timer, runDue, post } = await webhookBot();

    const response = await post(
      fake.webhookRequest(url, token, [{ text: "Book me a table" }], { signature }),
    );

    expect(response.status).toBe(400);
    timer.advance(500);
    await runDue();
    expect(await triggersOf(conversationId)).toEqual([]);
    expect(await messagesOf(conversationId)).toEqual([]);
    expect(await getTestDb().select().from(job)).toEqual([]);
    expect(brain.calls).toEqual([]);
  });

  it("rejects a request signed with another account's credentials", async () => {
    const { fake, conversationId, url, post } = await webhookBot();

    const response = await post(fake.webhookRequest(url, "2:other", [{ text: "Hi" }]));

    expect(response.status).toBe(400);
    expect(await triggersOf(conversationId)).toEqual([]);
  });

  it("answers 404 for an account it doesn't have", async () => {
    const { fake, post } = await webhookBot();

    const response = await post(
      fake.webhookRequest(`https://host.example/api/chat/channels/fake/${uuidv7()}`, token, [
        { text: "Hi" },
      ]),
    );

    expect(response.status).toBe(404);
  });

  it("handles a repeated platform message id once, at whichever instance it reaches", async () => {
    let checks = 0;
    const { fake, conversationId, url, post, instance } = await webhookBot({
      isBlocked: async () => {
        checks += 1;
        return false;
      },
    });
    const other = instance();
    checks = 0;

    const first = await post(fake.webhookRequest(url, token, [{ sourceId: "9", text: "Hi" }]));
    await expect.poll(async () => (await triggersOf(conversationId)).length, poll).toBe(1);
    const again = await post(fake.webhookRequest(url, token, [{ sourceId: "9", text: "Hi" }]));
    const elsewhere = await post(
      fake.webhookRequest(url, token, [{ sourceId: "9", text: "Hi" }]),
      other,
    );

    expect([first.status, again.status, elsewhere.status]).toEqual([202, 202, 202]);
    // Settled: stopping waits for each instance's accepted work.
    for (const { part, deps } of started) await part.stop!(deps);
    expect(await triggersOf(conversationId)).toHaveLength(1);
    expect(await messagesOf(conversationId)).toHaveLength(1);
    // The retries never reached the inbound path: only the first was checked against the Ban.
    expect(checks).toBe(1);
  });

  it("answers before the work after accepting is done", async () => {
    let release!: () => void;
    let held: Promise<boolean> | null = null;
    const { fake, conversationId, url, post } = await webhookBot({
      isBlocked: async () => (held ? await held : false),
    });
    held = new Promise<boolean>((resolve) => (release = () => resolve(false)));

    try {
      // The work waits on the Ban check, which holds until released: the answer mustn't wait.
      const response = await Promise.race([
        post(fake.webhookRequest(url, token, [{ text: "Hi" }])),
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 5_000)),
      ]);

      expect(response).not.toBe("held");
      expect((response as Response).status).toBe(202);
      expect(await triggersOf(conversationId)).toEqual([]);
    } finally {
      release();
    }
    await expect.poll(async () => (await triggersOf(conversationId)).length, poll).toBe(1);
  });
});
