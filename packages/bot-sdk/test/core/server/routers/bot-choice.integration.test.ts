import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { botTrigger, botTurn } from "../../../../core/server/storage";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { richControlJsonSchema } from "../../../../plugins/bot/client/index";
import { saveCredentials } from "../../../../plugins/models/server/internal";
import { inProcessRunner, type JobRunner } from "../../../../plugins/runner/server/internal";
import { fakeComputerProvider } from "../../../support/fake-computer-provider";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { fakeReviewer } from "../../../support/fake-reviewer";
import { followSend } from "../../../support/follow-send";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const question = "Which color?";

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

async function send(client: Client, botId: string, words: string) {
  for await (const _ of await followSend(client, { botId, id: uuidv7(), text: words }));
}

const asks = (other = false) =>
  toolCall({
    name: "send_to_user",
    input: { text: question, endTurn: true, choice: { options: ["Red", "Blue"], other } },
  });

const says = (text: string) => toolCall({ name: "send_to_user", input: { text, endTurn: true } });

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

/** The newest Message of the Bot that holds a choice. */
const lastChoice = async (client: Client, botId: string) =>
  (await client.bots.get({ botId })).messages.findLast(
    (entry) => entry.control?.kind === "choice",
  )!;

const answerTriggers = async () =>
  (await getTestDb().select().from(botTrigger).orderBy(asc(botTrigger.receivedAt))).filter(
    (trigger) => trigger.id.startsWith("action:"),
  );

describe("Multiple choice", () => {
  it("saves a choice control the published JSON Schema accepts", async () => {
    const { client, botId } = await botWith([round(asks(true))]);

    await send(client, botId, "pick for me");

    const asked = await lastChoice(client, botId);
    expect(asked).toMatchObject({
      role: "assistant",
      text: question,
      control: { kind: "choice", options: ["Red", "Blue"], other: true },
    });
    expect(asked.control).not.toHaveProperty("answer");
    expect(z.fromJSONSchema(richControlJsonSchema).safeParse(asked.control).success).toBe(true);
  });

  it("wakes the Bot with exactly one Trigger and refuses a second answer", async () => {
    const { client, botId, fake } = await botWith([round(asks()), round(says("Red it is."))]);
    await send(client, botId, "pick for me");
    await turnsEnded(botId, 1);
    const asked = await lastChoice(client, botId);
    const { lastSeq } = await client.bots.get({ botId });

    await client.bots.choose({ botId, messageId: asked.id, answer: { option: "Red" } });
    await turnsEnded(botId, 2);

    expect(await answerTriggers()).toMatchObject([
      {
        id: `action:${asked.id}`,
        source: "user",
        channel: "web",
        messageId: null,
        text: `Answered "${question}": Red`,
      },
    ]);
    expect(JSON.stringify(fake.calls[1]?.messages)).toContain(`Answered \\"${question}\\": Red`);
    // The answered state is stored, and is a change in the log.
    expect((await lastChoice(client, botId)).control).toMatchObject({
      answer: { text: "Red", other: false },
    });
    const { changes } = (await client.bots.changes({ botId, since: lastSeq })) as {
      changes: { kind: string; refId: string }[];
    };
    expect(changes).toContainEqual(expect.objectContaining({ kind: "message", refId: asked.id }));

    // The first answer won: a second is refused and changes nothing.
    await expect(
      client.bots.choose({ botId, messageId: asked.id, answer: { option: "Blue" } }),
    ).rejects.toMatchObject({ data: { code: "error.choiceAnswered" } });
    expect((await lastChoice(client, botId)).control).toMatchObject({ answer: { text: "Red" } });
    expect(await answerTriggers()).toHaveLength(1);
  });

  it("sends the free text of Other, only when the Bot offered it", async () => {
    const { client, botId } = await botWith([
      round(asks(false)),
      round(says("Noted.")),
      round(asks(true)),
      round(says("Green, then.")),
    ]);
    await send(client, botId, "pick for me");
    await turnsEnded(botId, 1);
    const closed = await lastChoice(client, botId);
    await expect(
      client.bots.choose({ botId, messageId: closed.id, answer: { other: "Green" } }),
    ).rejects.toMatchObject({ data: { code: "error.choiceInvalid" } });
    await expect(
      client.bots.choose({ botId, messageId: closed.id, answer: { option: "Green" } }),
    ).rejects.toMatchObject({ data: { code: "error.choiceInvalid" } });
    expect(await answerTriggers()).toHaveLength(0);
    await client.bots.choose({ botId, messageId: closed.id, answer: { option: "Blue" } });
    await turnsEnded(botId, 2);

    await send(client, botId, "again");
    await turnsEnded(botId, 3);
    const open = await lastChoice(client, botId);
    expect(open.id).not.toBe(closed.id);
    await expect(
      client.bots.choose({ botId, messageId: open.id, answer: { other: "   " } }),
    ).rejects.toMatchObject({ data: { code: "error.choiceInvalid" } });
    await client.bots.choose({ botId, messageId: open.id, answer: { other: " Green " } });
    await turnsEnded(botId, 4);

    const triggers = await answerTriggers();
    expect(triggers.at(-1)?.text).toBe(`Answered "${question}": Green`);
    expect((await lastChoice(client, botId)).control).toMatchObject({
      answer: { text: "Green", other: true },
    });
  });

  it("still wakes the Bot when it is answered after the Bot has moved on", async () => {
    const { client, botId } = await botWith([
      round(asks()),
      round(says("Anything else?")),
      round(says("Blue, noted.")),
    ]);
    await send(client, botId, "pick for me");
    await turnsEnded(botId, 1);
    const asked = await lastChoice(client, botId);
    await send(client, botId, "never mind, something else");
    await turnsEnded(botId, 2);

    await client.bots.choose({ botId, messageId: asked.id, answer: { option: "Blue" } });
    await turnsEnded(botId, 3);

    const { messages } = await client.bots.get({ botId });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "Blue, noted." });
  });

  it("refuses another user and a Message that holds no choice", async () => {
    const { client, botId, deps } = await botWith([round(asks()), round(says("Hi."))]);
    await send(client, botId, "pick for me");
    const asked = await lastChoice(client, botId);
    const intruder = chatRpc({ user: await insertUser(), deps });
    await expect(
      intruder.bots.choose({ botId, messageId: asked.id, answer: { option: "Red" } }),
    ).rejects.toMatchObject({ data: { code: "error.botNotFound" } });
    const user = (await client.bots.get({ botId })).messages.find(
      (entry) => entry.role === "user",
    )!;
    await expect(
      client.bots.choose({ botId, messageId: user.id, answer: { option: "Red" } }),
    ).rejects.toMatchObject({ data: { code: "error.messageNotFound" } });
  });
});
