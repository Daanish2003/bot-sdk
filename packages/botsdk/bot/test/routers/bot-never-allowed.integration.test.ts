import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botReview } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeReviewer, verdictRound } from "@botsdk/testing/fake-reviewer";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { followSend } from "@ai-chat/test-support/follow-send";
import { sdkNeverAllowed } from "@botsdk/client/bot/rule";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const timeout = 30_000;

type Round = ReturnType<typeof round>;

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A user with a Bot "Ada" and a Computer, whose Turn plays `rounds` and whose reviewer plays `reply`. */
async function botWith(
  rounds: Round[],
  reply: Parameters<typeof fakeReviewer>[0],
  safety?: { neverAllowed: string[] },
) {
  const queue = [...rounds];
  const fake = createFakeAdapter({
    rounds: Array.from(
      { length: 60 },
      () => (options: TextOptions) => (isTurnCall(options) ? (queue.shift() ?? round()) : round()),
    ),
  });
  const reviewer = fakeReviewer(reply);
  const computerFake = fakeComputerProvider();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    jobs,
    adapterFor: () => fake.adapter,
    reviewAdapterFor: () => reviewer.adapter,
    memory: false,
    safety,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada", model });
  return { fake, reviewer, computerFake, client, botId };
}

const shell = (command: string) => toolCall({ name: "shell", input: { command } });
const sends = (text: string) => toolCall({ name: "send_to_user", input: { text, endTurn: true } });

async function send(client: ReturnType<typeof chatRpc>, botId: string, words: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text: words })) {
    // Read to the end of the Turn.
  }
}

const messagesOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

/** What the Model was told by the tool result of its first call, in the second model call. */
function toolResultOf(call: TextOptions | undefined): unknown {
  const result = messagesOf(call).find((message) => message.role === "tool");
  const content = result?.content;
  return typeof content === "string" ? JSON.parse(content) : content;
}

const reviewsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botReview)
    .where(eq(botReview.botId, botId))
    .orderBy(asc(botReview.createdAt));

const hostClass = "deleting a customer's account";

describe("Never-allowed actions and hand-off rules", () => {
  it(
    "blocks a never verdict with no Approval: the command never runs, and the Model is told to hand it over",
    { timeout },
    async () => {
      const { client, botId, computerFake, fake } = await botWith(
        [round(shell("bank transfer --to 123 --amount 5000")), round(sends("Over to you."))],
        () =>
          verdictRound({
            outcome: "never",
            reason: "moving money between accounts",
            summary: "Transfer $5,000",
          }),
      );

      await send(client, botId, "move my savings");

      expect(computerFake.callsOf("run")).toEqual([]);
      const [review, ...others] = await reviewsOf(botId);
      expect(others).toEqual([]);
      expect(review).toMatchObject({
        verdict: "never",
        state: null,
        deadline: null,
        summary: "Transfer $5,000",
      });
      expect(toolResultOf(fake.calls[1])).toEqual({
        error:
          "Never allowed: moving money between accounts. Tell the user to do it themselves; don't try another way.",
      });
      expect(await client.reviews.list({ botId })).toEqual([
        expect.objectContaining({ verdict: "never", state: null }),
      ]);
    },
  );

  it(
    "blocks a hand-off verdict with no Approval, and tells the Model the user does it themselves",
    { timeout },
    async () => {
      const { client, botId, computerFake, fake } = await botWith(
        [round(shell("deploy --prod")), round(sends("Over to you."))],
        () =>
          verdictRound({
            outcome: "hand_off",
            reason: "Your rule hands off deploys",
            summary: "Deploy to production",
          }),
      );
      await client.rules.create({ text: "I deploy myself", mode: "hand_off" });

      await send(client, botId, "ship it");

      expect(computerFake.callsOf("run")).toEqual([]);
      const [review] = await reviewsOf(botId);
      expect(review).toMatchObject({ verdict: "block", state: null, deadline: null });
      expect(toolResultOf(fake.calls[1])).toEqual({
        error:
          "Handed off: Your rule hands off deploys. The user does this themselves, and no Approval is offered. Tell them what to do; don't try another way.",
      });
    },
  );

  it(
    "shows the reviewer the SDK's classes and the Host's extra ones, even with a without-asking rule",
    { timeout },
    async () => {
      const { client, botId, reviewer, computerFake } = await botWith(
        [round(shell("wire --all")), round(sends("Done."))],
        () => verdictRound({ outcome: "never", reason: "moving money", summary: "Wire money" }),
        { neverAllowed: [hostClass] },
      );
      await client.rules.create({ text: "Wire money whenever needed", mode: "without_asking" });

      await send(client, botId, "wire it");

      const input = String(messagesOf(reviewer.calls[0])[0]?.content);
      const list = input.slice(
        input.indexOf("# Never-allowed actions"),
        input.indexOf("# The call"),
      );
      expect(list).toBe(
        `# Never-allowed actions\n\n${[...sdkNeverAllowed, hostClass]
          .map((never) => `- ${never}`)
          .join("\n")}\n\n`,
      );
      // The rule is listed to the reviewer, but the verdict still blocks.
      expect(input).toContain("- [without asking] Wire money whenever needed");
      expect(computerFake.callsOf("run")).toEqual([]);
      expect((await reviewsOf(botId))[0]).toMatchObject({ verdict: "never", state: null });
    },
  );

  it(
    "lists the SDK's classes and then the Host's through rules.neverAllowed",
    { timeout },
    async () => {
      const { client } = await botWith(
        [],
        () => verdictRound({ outcome: "pass", reason: "ok", summary: "ok" }),
        { neverAllowed: [hostClass] },
      );

      expect(await client.rules.neverAllowed()).toEqual([...sdkNeverAllowed, hostClass]);
    },
  );
});
