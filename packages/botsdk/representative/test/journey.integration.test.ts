import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { saveCredentials } from "@botsdk/bot/models/internal";
import type { BotSdkPlugin } from "@botsdk/bot/plugin";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { botAssignment } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { promoteAutoTopic } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter } from "@botsdk/testing/fake-adapter";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";

import { connectChannelAccount } from "../src/server/channel-accounts";
import { representativeFeature } from "../src/server/plugin";
import {
  botRounds,
  journeyBotModel,
  journeyModel,
  journeyRounds,
  price,
  releaseOne,
  walkJourney,
} from "./journey";

/*
 * The Representatives map's journey as one test (ticket #1335), through `fakeMessagingAdapter` with
 * fake Models on real Postgres: an owner approves a Release, a stranger messages in on the account
 * the Representative holds, is answered from a fact and from memory, has work handed to the Bot,
 * and is told its result through the gate; then the owner takes over, hands back, and rolls back.
 * The steps live in `journey.ts`, so web chat can walk them through its routes (#1341).
 */

vi.setConfig({ testTimeout: 30_000 });

const silent = { error: () => {} };
const poll = { timeout: 10_000 };
// 09:00 UTC: outside a Representative's default quiet hours.
const at = new Date("2026-10-22T09:00:00.000Z");

const runners: JobRunner[] = [];
const started: { part: BotSdkPlugin; deps: TestDeps }[] = [];

afterEach(async () => {
  for (const { part, deps } of started.splice(0)) await part.stop!(deps);
  for (const runner of runners.splice(0)) await runner.stop();
});

describe("the Representative's journey", () => {
  it("runs from an approved Release to a rollback, through a Channel account", async () => {
    const channel = fakeMessagingAdapter();
    // The platform vouches for its senders, as Telegram does in a private chat: so the Customer is remembered.
    channel.adapter.verifiesSender = true;
    const fake = createFakeAdapter({ rounds: journeyRounds({ remembered: true }) });
    const botFake = createFakeAdapter({ rounds: botRounds });
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
      channels: [channel.adapter],
      features: [representativeFeature()],
      adapterFor: (model) => (model === journeyBotModel ? botFake.adapter : fake.adapter),
      clock: timer.clock.now,
      memory: false,
    });
    made = deps;
    await jobs.start();
    runners.push(jobs);
    const part = deps.parts.all.find((one) => one.id === "channel")!;
    await part.start!(deps);
    started.push({ part, deps });

    const user = await insertUser();
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const rpc = chatRpc({ user, deps });
    const { id: botId } = await rpc.bots.create({ name: "Clerk", model: journeyBotModel });
    const { id } = await rpc.representative.create({ name: "Front desk", botId });
    await rpc.representative.updateDraft({
      id,
      draft: {
        jobText: releaseOne,
        model: journeyModel,
        tools: ["reply", "hand_to_bot"],
      },
    });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    await promoteAutoTopic(id);
    await rpc.representative.factAdd(price);
    const context = deps.parts.features.find(
      ({ feature }) => feature.id === "representative",
    )!.context;
    await connectChannelAccount(context, {
      userId: user.id,
      representativeId: id,
      platform: channel.adapter.id,
      credentials: { token: "1:a" },
    });
    await expect.poll(() => channel.listening.has("@bot_1"), poll).toBe(true);

    // A stranger on the platform: the update reaches the account's listener, as it would from the platform.
    const tick = async () => {
      timer.advance(batchLongestMs);
      timer.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await walkJourney(
      {
        rpc,
        representativeId: id,
        modelCalls: () => fake.calls,
        botCalls: () => botFake.calls.length,
        tick,
        visitor: {
          says: (text) => channel.deliver("@bot_1", { text }),
          heard: async () => channel.delivered.map(({ part: sent }) => sent),
        },
        assignmentStatuses: async () =>
          (
            await getTestDb()
              .select({ status: botAssignment.status })
              .from(botAssignment)
              .where(eq(botAssignment.assignedBotId, botId))
          ).map(({ status }) => status),
      },
      { remembered: true },
    );
  });
});
