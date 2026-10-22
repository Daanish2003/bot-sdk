import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botTrigger, botTurn } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { computer } from "../../../../plugins/computer/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { fakeReviewer } from "../../../support/fake-reviewer";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-5.6";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];
type Client = ReturnType<typeof chatRpc>;

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A user with an OpenAI key and a Bot, whose Model plays `rounds`. */
async function botWith(rounds: Round[]) {
  const fake = createFakeAdapter({ rounds });
  const reviewer = fakeReviewer();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({ db: getTestDb(), logger: silent, drainMs: 50, deps: () => deps! });
  deps = createTestSdk({
    plugins: [bot(), computer({ provider: fakeComputerProvider().provider })],
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
  const { id: botId } = await client.bot.create({ name: "Ada", model });
  return { fake, deps, client, user, botId };
}

async function send(client: Client, botId: string, words: string, id = uuidv7()) {
  for await (const _ of await client.bot.send({ botId, id, text: words }));
}

const says = (text: string) => toolCall({ name: "send_to_user", input: { text, endTurn: true } });

const reacts = (messageId: string, emoji: string, text = "") =>
  toolCall({
    name: "send_to_user",
    input: { text, endTurn: true, react: { messageId, emoji } },
  });

const turnCount = async (botId: string) =>
  (await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId))).length;

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

const messageOf = async (client: Client, botId: string, id: string) =>
  (await client.bot.get({ botId })).messages.find((entry) => entry.id === id)!;

const inputOf = (call: { messages: unknown } | undefined) => JSON.stringify(call?.messages);

describe("Reactions", () => {
  it("puts the user's emoji on a Bot Message, one at a time, without waking the Bot", async () => {
    const { client, botId } = await botWith([round(says("Hello."))]);
    await send(client, botId, "hi");
    await turnsEnded(botId, 1);
    const reply = (await client.bot.get({ botId })).messages.find(
      (entry) => entry.role === "assistant",
    )!;
    const { lastSeq } = await client.bot.get({ botId });

    await client.bot.react({ botId, messageId: reply.id, emoji: "👍" });
    expect((await messageOf(client, botId, reply.id)).reactions).toMatchObject({
      user: { emoji: "👍" },
    });
    await client.bot.react({ botId, messageId: reply.id, emoji: "❤️" });

    const after = await messageOf(client, botId, reply.id);
    expect(after.reactions).toMatchObject({ user: { emoji: "❤️" } });
    expect(after.text).toBe("Hello.");
    // A state change in the log, so every tab hears of it; and no Turn started.
    const { changes } = (await client.bot.changes({ botId, since: lastSeq })) as {
      changes: { kind: string; refId: string }[];
    };
    expect(changes.filter((change) => change.refId === reply.id)).toHaveLength(2);
    expect(await getTestDb().select().from(botTrigger)).toHaveLength(1);
    expect(await turnCount(botId)).toBe(1);

    await client.bot.react({ botId, messageId: reply.id, emoji: null });
    expect((await messageOf(client, botId, reply.id)).reactions).toBeUndefined();
  });

  it("refuses another user, the user's own Message and a word that is no emoji", async () => {
    const { client, botId, deps } = await botWith([round(says("Hello."))]);
    await send(client, botId, "hi");
    const { messages } = await client.bot.get({ botId });
    const reply = messages.find((entry) => entry.role === "assistant")!;
    const mine = messages.find((entry) => entry.role === "user")!;
    const intruder = chatRpc({ user: await insertUser(), deps });

    await expect(
      intruder.bot.react({ botId, messageId: reply.id, emoji: "👍" }),
    ).rejects.toMatchObject({ data: { code: "error.botNotFound" } });
    await expect(
      client.bot.react({ botId, messageId: mine.id, emoji: "👍" }),
    ).rejects.toMatchObject({ data: { code: "error.messageNotFound" } });
    await expect(client.bot.react({ botId, messageId: reply.id, emoji: "yes" })).rejects.toThrow();
  });

  it("tells the Bot of the user's reaction in its next Turn's input, once", async () => {
    const { client, botId, fake } = await botWith([
      round(says("Here is the plan.")),
      round(says("Glad.")),
      round(says("Anything else?")),
    ]);
    await send(client, botId, "plan please");
    await turnsEnded(botId, 1);
    const reply = (await client.bot.get({ botId })).messages.find(
      (entry) => entry.role === "assistant",
    )!;
    await client.bot.react({ botId, messageId: reply.id, emoji: "🎉" });

    await send(client, botId, "next");
    await turnsEnded(botId, 2);
    await send(client, botId, "and then");
    await turnsEnded(botId, 3);

    expect(inputOf(fake.calls[1])).toContain('🎉 on your message \\"Here is the plan.\\"');
    // The later Turn replays the earlier input as it was, and adds no second notice of its own.
    const third = fake.calls[2]!.messages as { content: unknown }[];
    expect(String(third.at(-1)?.content)).not.toContain("🎉");
    expect(inputOf(fake.calls[2]).split("The user reacted").length - 1).toBe(1);
  });

  it("lets the Bot react to a user Message with no Message of its own, and replace it", async () => {
    const id = uuidv7();
    const { client, botId, fake } = await botWith([
      round(reacts(id, "🙏")),
      round(reacts(id, "❤️")),
    ]);

    await send(client, botId, "thanks!", id);
    await turnsEnded(botId, 1);
    const { lastSeq, messages } = await client.bot.get({ botId });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id, role: "user", reactions: { bot: { emoji: "🙏" } } });
    // The Bot was told which Message to react to.
    expect(inputOf(fake.calls[0])).toContain(id);

    await send(client, botId, "really, thanks", uuidv7());
    await turnsEnded(botId, 2);
    expect((await messageOf(client, botId, id)).reactions).toMatchObject({
      bot: { emoji: "❤️" },
    });
    const { changes } = (await client.bot.changes({ botId, since: lastSeq })) as {
      changes: { kind: string; refId: string }[];
    };
    expect(changes).toContainEqual(expect.objectContaining({ kind: "message", refId: id }));
    expect((await client.bot.get({ botId })).messages).toHaveLength(2);
  });

  it("refuses a reaction with text, with a control, or to a Message that is not the user's", async () => {
    const id = uuidv7();
    const { client, botId, fake } = await botWith([
      round(reacts(id, "👍", "Thanks!")),
      round(reacts(uuidv7(), "👍")),
    ]);

    await send(client, botId, "thanks!", id);
    await turnsEnded(botId, 1);
    await send(client, botId, "thanks again");
    await turnsEnded(botId, 2);

    expect(inputOf(fake.calls[1])).toContain("A reaction is sent alone");
    expect(inputOf(fake.calls[2])).toContain("No message of the user has that id");
    expect((await messageOf(client, botId, id)).reactions).toBeUndefined();
  });

  it("keeps an emoji when a control on the Message changes state", async () => {
    const { client, botId } = await botWith([
      round(
        toolCall({
          name: "send_to_user",
          input: { text: "Which?", endTurn: true, choice: { options: ["Red", "Blue"] } },
        }),
      ),
      round(says("Red it is.")),
    ]);
    await send(client, botId, "pick");
    await turnsEnded(botId, 1);
    const asked = (await client.bot.get({ botId })).messages.find(
      (entry) => entry.control?.kind === "choice",
    )!;
    await client.bot.react({ botId, messageId: asked.id, emoji: "👍" });

    await client.bot.choose({ botId, messageId: asked.id, answer: { option: "Red" } });

    expect(await messageOf(client, botId, asked.id)).toMatchObject({
      control: { answer: { text: "Red" } },
      reactions: { user: { emoji: "👍" } },
    });
  });
});
