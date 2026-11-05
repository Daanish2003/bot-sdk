import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { batchLongestMs } from "@botsdk/bot/bot/triggers";
import { toNodeHandler } from "@botsdk/bot/http";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createHttpHandlerOver } from "@botsdk/bot/over";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { botAssignment } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { promoteAutoTopic } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter } from "@botsdk/testing/fake-adapter";

import { noCustomerChannel } from "../src/server/customer-proof";
import { representativeFeature } from "../src/server/plugin";
import type { WebChatMessage } from "../src/shared/contract";
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
 * The Representatives map's journey through web chat (ticket #1341): the same steps as
 * `journey.integration.test.ts`, with the Customer a widget visitor on the public routes, over real
 * HTTP, a fake Model and real Postgres. A web chat session is never verified, so no prompt may hold
 * a Customer's memory; and since web chat can't start a conversation, the Bot's result waits for the
 * owner (a Reply draft) before the visitor reads it.
 */

vi.setConfig({ testTimeout: 30_000 });

const basePath = "/api/chat";
const shop = "https://shop.example";
const cookie = "session=the-owner";

const servers: Server[] = [];
const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("the Representative's journey through web chat", () => {
  it("runs from an approved Release to a rollback, over the public routes", async () => {
    const fake = createFakeAdapter({ rounds: journeyRounds({ remembered: false }) });
    const botFake = createFakeAdapter({ rounds: botRounds });
    const timer = fakeJobClock(new Date("2026-11-05T12:00:00Z"));
    let made: TestDeps | undefined;
    const jobs = inProcessRunner({
      db: getTestDb(),
      logger: { error: () => {} },
      drainMs: 50,
      clock: timer.clock,
      jobs: () => made!.parts.jobs,
    });
    const deps = createTestSdk({
      jobs,
      features: [representativeFeature({}, noCustomerChannel)],
      adapterFor: (model) => (model === journeyBotModel ? botFake.adapter : fake.adapter),
      clock: timer.clock.now,
      memory: false,
    });
    made = deps;
    await jobs.start();
    runners.push(jobs);

    const user = await insertUser();
    const server = createServer(
      toNodeHandler(
        createHttpHandlerOver(deps, {
          basePath,
          getUser: (request) => (request.headers.get("cookie") === cookie ? user : null),
        }),
      ),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${basePath}/representative/widget`;

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
      draft: { jobText: releaseOne, model: journeyModel, tools: ["reply", "hand_to_bot"] },
    });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    await promoteAutoTopic(id);
    await rpc.representative.factAdd(price);
    await rpc.representative.widgetKeyCreate({ id });
    const { key } = await rpc.representative.widgetKeySetOrigins({ id, origins: [shop] });

    // The visitor's page: only the public routes, as a browser sends them across origins.
    const session = await fetch(`${url}/${key}/session`, {
      method: "POST",
      headers: { origin: shop },
    });
    const { token } = (await session.json()) as { token: string };
    const post = (path: string, body: unknown) =>
      fetch(`${url}/${path}`, {
        method: "POST",
        headers: { origin: shop, "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(body),
      });

    await walkJourney(
      {
        rpc,
        representativeId: id,
        modelCalls: () => fake.calls,
        botCalls: () => botFake.calls.length,
        tick: async () => {
          timer.advance(batchLongestMs);
          timer.tick();
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
        visitor: {
          says: async (text) => {
            expect((await post("send", { token, text })).status).toBe(202);
          },
          heard: async () => {
            const response = await post("read", { token });
            expect(response.status).toBe(200);
            const { messages } = (await response.json()) as { messages: WebChatMessage[] };
            return messages.filter(({ from }) => from === "business").map(({ text }) => text);
          },
        },
        assignmentStatuses: async () =>
          (
            await getTestDb()
              .select({ status: botAssignment.status })
              .from(botAssignment)
              .where(eq(botAssignment.assignedBotId, botId))
          ).map(({ status }) => status),
      },
      { remembered: false, resultHeld: true },
    );
  });
});
