import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botTurn } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { followSend } from "@ai-chat/test-support/follow-send";
import { fakeReviewer } from "@botsdk/testing/fake-reviewer";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];
type Client = ReturnType<typeof chatRpc>;

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A user with an OpenAI key and a Bot, whose Model plays `rounds`. */
async function botWith(rounds: Round[]) {
  const fake = createFakeAdapter({ rounds });
  const reviewer = fakeReviewer();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: fakeComputerProvider().provider,
    jobs,
    adapterFor: () => fake.adapter,
    reviewAdapterFor: () => reviewer.adapter,
    memory: false,
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
  return { fake, deps, client, user, botId };
}

async function send(client: Client, botId: string, words: string, id = uuidv7()) {
  for await (const _ of await followSend(client, { botId, id, text: words }));
}

const turnsEnded = (botId: string, count: number) =>
  expect
    .poll(
      async () => {
        const turns = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
        return turns.length === count && turns.every((turn) => turn.status !== "running");
      },
      { timeout: 10_000 },
    )
    .toBe(true);

describe("Urgent Messages", () => {
  it("stores urgent on the Message and returns it, and marks only that Message", async () => {
    const { client, botId } = await botWith([
      round(
        toolCall({
          name: "send_to_user",
          input: { text: "Server is down.", endTurn: false, urgent: true },
        }),
        toolCall({ name: "send_to_user", input: { text: "Looking now.", endTurn: true } }),
      ),
    ]);
    await send(client, botId, "status?");
    await turnsEnded(botId, 1);

    const sent = (await client.bots.get({ botId })).messages.filter(
      (entry) => entry.role === "assistant",
    );
    expect(sent.map((entry) => [entry.text, entry.urgent])).toEqual([
      ["Server is down.", true],
      ["Looking now.", undefined],
    ]);
  });

  it("keeps urgent when a control changes state", async () => {
    const { client, botId } = await botWith([
      round(
        toolCall({
          name: "send_to_user",
          input: {
            text: "Deploy now?",
            endTurn: true,
            urgent: true,
            choice: { options: ["Yes", "No"] },
          },
        }),
      ),
      round(toolCall({ name: "send_to_user", input: { text: "Done.", endTurn: true } })),
    ]);
    await send(client, botId, "go");
    await turnsEnded(botId, 1);
    const card = (await client.bots.get({ botId })).messages.find(
      (entry) => entry.control?.kind === "choice",
    )!;
    expect(card.urgent).toBe(true);

    await client.bots.choose({ botId, messageId: card.id, answer: { option: "Yes" } });
    await turnsEnded(botId, 2);
    const answered = (await client.bots.get({ botId })).messages.find(
      (entry) => entry.id === card.id,
    )!;
    expect(answered.control).toMatchObject({ answer: { text: "Yes" } });
    expect(answered.urgent).toBe(true);
  });
});
