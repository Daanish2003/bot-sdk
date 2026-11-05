import type { AnyTextAdapter } from "@tanstack/ai";
import { and, count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import type { CustomerChannel } from "../src/server/customer-proof";
import { representativeThread, representativeThreadMessage } from "../src/server/db/schema";
import { inboundLimit } from "../src/server/inbound-limit";
import { representativeFeature } from "../src/server/plugin";
import { receiveCustomerMessage } from "../src/server/thread-turns";

/*
 * Inbound is limited per identity (ticket #1311), through the real inbound path: a fake Model on real
 * Postgres and a fake clock. The extra message is logged, not stored, and starts no Turn.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
// 09:00 UTC: outside a Representative's default quiet hours.
const at = new Date("2026-10-22T09:00:00.000Z");
const hourMs = 60 * 60_000;
const number = "+15550002";
const script = "Call 112, or leave the building now.";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A running instance with an approved Release whose emergency keyword is "fire". */
async function instance(rounds: Round[]) {
  const fake = createFakeAdapter({ rounds });
  const adapter: AnyTextAdapter = fake.adapter;
  const messaging = fakeMessagingAdapter();
  const account = {
    id: "account",
    botId: "bot",
    platformBotId: "1",
    handle: "@bot_1",
    credentials: { token: "1:secret" },
  };
  const channel: CustomerChannel = {
    send: async (to, { text }) => {
      await messaging.adapter.send(account, { chatId: to.externalId, text }, { fetch });
    },
    sendProof: async () => {},
  };
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
    features: [representativeFeature({}, channel)],
    adapterFor: () => adapter,
    clock: timer.clock.now,
    memory: false,
  });
  made = deps;
  await jobs.start();
  runners.push(jobs);

  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({
    id,
    draft: {
      jobText: "Answer questions.",
      model,
      tools: ["reply"],
      emergencyText: script,
      emergencyKeywords: ["fire"],
    },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  const logged: unknown[][] = [];
  const context = {
    ...deps.parts.features.find(({ feature }) => feature.id === "representative")!.context,
    logger: { error: (...args: unknown[]) => void logged.push(args) },
    channel,
  };
  const threadOf = async (externalId: string) => {
    const [thread] = await getTestDb()
      .select({ id: representativeThread.id })
      .from(representativeThread)
      .innerJoin(
        representativeThreadMessage,
        eq(representativeThreadMessage.threadId, representativeThread.id),
      )
      .where(eq(representativeThreadMessage.externalId, externalId))
      .limit(1);
    return thread!.id;
  };
  const stored = async (externalId: string) => {
    const [row] = await getTestDb()
      .select({ n: count() })
      .from(representativeThreadMessage)
      .where(
        and(
          eq(representativeThreadMessage.externalId, externalId),
          eq(representativeThreadMessage.author, "customer"),
        ),
      );
    return row!.n;
  };
  const arrives = (message: string, externalId = number) =>
    receiveCustomerMessage(context, { representativeId: id, channel: "fake", externalId, message });
  /** Has the identity already sent `n` messages by now, by writing them to its thread. */
  const alreadySent = async (externalId: string, n: number) => {
    await arrives("first", externalId);
    const threadId = await threadOf(externalId);
    await getTestDb()
      .insert(representativeThreadMessage)
      .values(
        Array.from({ length: n - 1 }, (_, i) => ({
          id: crypto.randomUUID(),
          threadId,
          position: i + 2,
          author: "customer" as const,
          channel: "fake",
          externalId,
          text: "again",
          createdAt: timer.clock.now(),
        })),
      );
    await getTestDb()
      .update(representativeThread)
      .set({ messageCount: n })
      .where(eq(representativeThread.id, threadId));
  };
  return { arrives, alreadySent, stored, logged, timer, rpc, id, got: () => messaging.delivered };
}

describe("the inbound limit", () => {
  it("logs the sixty-first message in an hour, stores none of it and starts no Turn", async () => {
    const world = await instance([round()]);
    await world.alreadySent(number, inboundLimit);

    const received = await world.arrives("One more");

    expect(received).toEqual({ jobId: null });
    expect(await world.stored(number)).toBe(inboundLimit);
    expect(world.logged).toHaveLength(1);
  });

  it("counts each identity on its own", async () => {
    const world = await instance([round(), round()]);
    await world.alreadySent(number, inboundLimit);

    const other = await world.arrives("Hello", "+15550003");

    expect(other?.jobId).toEqual(expect.any(String));
    expect(await world.stored("+15550003")).toBe(1);
    expect(world.logged).toEqual([]);
  });

  it("hears the identity again an hour later", async () => {
    const world = await instance([round(), round()]);
    await world.alreadySent(number, inboundLimit);
    expect(await world.arrives("Too soon")).toEqual({ jobId: null });

    world.timer.advance(hourMs + 1);
    const later = await world.arrives("Back again");

    expect(later?.jobId).toEqual(expect.any(String));
    expect(await world.stored(number)).toBe(inboundLimit + 1);
  });

  it("lets STOP, START and an emergency keyword through over the limit", async () => {
    const world = await instance([round()]);
    await world.alreadySent(number, inboundLimit);

    await world.arrives("STOP");
    expect(await world.stored(number)).toBe(inboundLimit + 1);
    await world.arrives("START");
    expect(await world.stored(number)).toBe(inboundLimit + 2);
    await world.arrives("There is a fire");
    expect(await world.stored(number)).toBe(inboundLimit + 3);
    await vi.waitFor(() => expect(world.got().map(({ part }) => part)).toContain(script), {
      timeout: 10_000,
    });
    expect(world.logged).toEqual([]);
  });
});
