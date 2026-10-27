import type { AnyTextAdapter, ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { conversationChannel } from "../../src/chat/conversation-events";
import { botHelper, botHelperMessage, botTrigger, job } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import {
  askUserToolName,
  handOffAnswers,
  computerUseHelperPrompt,
  hasRunningHelper,
  helperMessagePrefix,
} from "../../src/bot/helpers";
import { findBot } from "../../src/bot/conversation";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner, systemClock } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round, text, toolCall } from "@botsdk/testing/fake-adapter";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { followSend } from "@ai-chat/test-support/follow-send";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** The runners the tests started, stopped after each test. */
const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) =>
    (typeof prompt === "string" ? prompt : prompt.content).startsWith("You are a Helper"),
  );

/**
 * A user with an OpenAI key and a Bot, over an SDK with `computer` on. The Turns play `turns` and
 * the Helpers play `helpers`. No Chrome answers on a Screen's DevTools port, so a Computer-use
 * Helper runs without its browser: these tests only hand the Screen over.
 */
async function botWith(turns: Round[], helpers: Round[], { clock }: { clock?: () => Date } = {}) {
  const turnFake = createFakeAdapter({ rounds: turns });
  const helperFake = createFakeAdapter({ rounds: helpers });
  const adapter = {
    ...turnFake.adapter,
    chatStream: (options: TextOptions) =>
      isHelperCall(options)
        ? helperFake.adapter.chatStream(options)
        : turnFake.adapter.chatStream(options),
  } as AnyTextAdapter;
  const computerFake = fakeComputerProvider({ hostUrl: () => "http://127.0.0.1:1" });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
    // The runner claims by the same clock that queues the jobs.
    ...(clock && { clock: { ...systemClock, now: clock } }),
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    jobs,
    adapterFor: () => adapter,
    ...(clock && { clock }),
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
  const created = await client.bots.create({ name: "Ada", model });
  return { turnFake, helperFake, computerFake, deps, client, user, botId: created.id };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, message: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text: message }));
}

const task = "Read the deals on the Salesforce dashboard.";
const reason = "Sign in to Salesforce: enter your password and the code from your phone.";

/** A Turn's first Step: it starts a Computer-use Helper on `task` and tells the user. */
const handsOff = round(
  toolCall({ name: "start_helper", input: { type: "computer_use", task } }),
  toolCall({ name: "send_to_user", input: { text: "On it.", endTurn: true } }),
);

const asksUser = round(toolCall({ name: askUserToolName, input: { reason } }));

const helpersOf = async (botId: string) =>
  getTestDb()
    .select()
    .from(botHelper)
    .where(eq(botHelper.botId, botId))
    .orderBy(asc(botHelper.startedAt), asc(botHelper.id));

async function statusIs(botId: string, status: string) {
  await expect
    .poll(async () => (await helpersOf(botId))[0]?.status, { timeout: 10_000 })
    .toBe(status);
  return (await helpersOf(botId))[0]!;
}

const jobOf = async (jobId: string | null) =>
  (await getTestDb().select().from(job).where(eq(job.id, jobId!)))[0];

/** The Conversation's Messages that carry a Computer card. */
const cardsOf = async (client: ReturnType<typeof chatRpc>, botId: string) =>
  (await client.bots.get({ botId })).messages.filter(
    (message) => message.control?.kind === "computer",
  );

/** The result the model input gives the `ask_user` call, as its tool message's content. */
const askUserAnswer = (input: ModelMessage[]) => {
  const id = input
    .flatMap((entry) => entry.toolCalls ?? [])
    .findLast((call) => call.function.name === askUserToolName)?.id;
  return JSON.parse(String(input.find((entry) => entry.toolCallId === id)?.content));
};

describe("handing the Screen to the user", () => {
  it("writes one Bot Message with the reason and a Computer card, waits, and ends its job with no Trigger", async () => {
    const { client, botId, user, helperFake, computerFake } = await botWith(
      [handsOff, round()],
      [asksUser],
    );

    await send(client, botId, "what deals are on my dashboard?");
    const helper = await statusIs(botId, "waiting");

    expect(helperFake.calls[0]?.systemPrompts).toEqual([computerUseHelperPrompt]);
    expect(computerUseHelperPrompt).toContain(
      "At a login, verification code, captcha or payment, stop and call `ask_user` with where " +
        "you are and what the user needs to do; never type a password or a code yourself.",
    );
    expect((helperFake.calls[0]?.tools ?? []).map((tool) => tool.name)).toContain(askUserToolName);
    const cards = await cardsOf(client, botId);
    expect(cards).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: reason,
        control: { kind: "computer", helperId: helper.id, reason, state: "open" },
      }),
    ]);
    // Its transcript is saved, ending with the call it waits on.
    expect(helper.transcript?.[0]).toEqual({ role: "user", content: task });
    expect(helper.transcript?.at(-2)?.toolCalls?.[0]?.function.name).toBe(askUserToolName);
    // It keeps its Screen, open, but not the Computer awake.
    expect(helper.screen).toBe(1);
    expect(computerFake.callsOf("run").filter((call) => call.command.includes(" stop "))).toEqual(
      [],
    );
    expect(await hasRunningHelper(getTestDb(), user.id)).toBe(false);
    // Its job has ended, and nothing woke the Bot.
    await expect.poll(async () => (await jobOf(helper.jobId))?.status).toBe("succeeded");
    expect(
      await getTestDb().select().from(botTrigger).where(eq(botTrigger.source, "helper")),
    ).toEqual([]);
    expect(await client.helpers.list({ botId })).toEqual([
      expect.objectContaining({ id: helper.id, status: "waiting", steps: 1 }),
    ]);
  });

  it("resumes on Done in a fresh job whose input answers the call, and the card reads done", async () => {
    const { client, botId, helperFake } = await botWith(
      [handsOff, round(), round()],
      [asksUser, round(text("There are 3 deals."))],
    );
    await send(client, botId, "what deals are on my dashboard?");
    const waiting = await statusIs(botId, "waiting");
    // The Bot messages it while it waits.
    await getTestDb().insert(botHelperMessage).values({
      id: uuidv7(),
      helperId: waiting.id,
      text: "Only open deals.",
      createdAt: new Date(),
    });

    // A second tap at the same time finds it running again, and leaves it be.
    expect(
      await Promise.all([
        client.helpers.done({ helperId: waiting.id }),
        client.helpers.done({ helperId: waiting.id }),
      ]),
    ).toEqual([{ status: "running" }, { status: "running" }]);
    const done = await statusIs(botId, "complete");

    expect(done.report).toBe("There are 3 deals.");
    expect(done.jobId).not.toBe(waiting.jobId);
    const input = (helperFake.calls[1]?.messages ?? []) as ModelMessage[];
    expect(input[0]).toEqual({ role: "user", content: task });
    expect(askUserAnswer(input)).toEqual({ result: handOffAnswers.done });
    // The Message arrives once it resumes.
    expect(input.at(-1)).toEqual({
      role: "user",
      content: `${helperMessagePrefix}Only open deals.`,
    });
    expect(
      (await cardsOf(client, botId)).map(
        (message) => message.control?.kind === "computer" && message.control.state,
      ),
    ).toEqual(["done"]);
    // The Steps carry over, and the full transcript is kept.
    expect(await client.helpers.list({ botId })).toEqual([
      expect.objectContaining({ status: "complete", steps: 2 }),
    ]);
    expect(askUserAnswer(done.transcript ?? [])).toEqual({ result: handOffAnswers.done });
    // Done once it ended is refused.
    await expect(client.helpers.done({ helperId: waiting.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This task was stopped.",
    });
  });

  it("hints the Conversation when the user stops a waiting Helper, so other tabs see its card close (#761)", async () => {
    const { deps, user, client, botId } = await botWith([handsOff, round()], [asksUser]);
    await send(client, botId, "what deals are on my dashboard?");
    const waiting = await statusIs(botId, "waiting");
    const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
    const events: string[] = [];
    await deps.pubsub.subscribe(conversationChannel(conversationId), (message) => {
      events.push(message);
    });

    await client.helpers.stop({ botId, helperId: waiting.id });

    await expect
      .poll(() => events, { timeout: 10_000 })
      .toEqual([JSON.stringify({ type: "changed" })]);
  }, 30_000);

  it("refuses Done on a stopped Helper, whose card reads cancelled", async () => {
    const { client, botId } = await botWith([handsOff, round()], [asksUser]);
    await send(client, botId, "what deals are on my dashboard?");
    const waiting = await statusIs(botId, "waiting");

    await client.helpers.stop({ botId, helperId: waiting.id });

    await expect(client.helpers.done({ helperId: waiting.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This task was stopped.",
    });
    expect(
      (await cardsOf(client, botId)).map(
        (message) => message.control?.kind === "computer" && message.control.state,
      ),
    ).toEqual(["cancelled"]);
    // Its transcript is the one it saved when it began to wait.
    expect((await helpersOf(botId))[0]?.transcript).toEqual(waiting.transcript);
  });

  it("shows on the to-do list as waiting for the user, with the reason", async () => {
    const { client, botId, turnFake } = await botWith([handsOff, round(), round()], [asksUser]);
    await send(client, botId, "what deals are on my dashboard?");
    const waiting = await statusIs(botId, "waiting");

    await send(client, botId, "any news?");

    const newest = (turnFake.calls.at(-1)?.messages ?? []).at(-1) as ModelMessage;
    expect(String(newest.content)).toContain(
      `${waiting.id} · Computer-use · waiting for the user: ${reason} · task: ${task} · since`,
    );
  });

  it("finds no Helper of another user's", async () => {
    const { client, botId, deps } = await botWith([handsOff, round()], [asksUser]);
    await send(client, botId, "what deals are on my dashboard?");
    const waiting = await statusIs(botId, "waiting");

    const other = chatRpc({ user: await insertUser(), deps });
    await expect(other.helpers.done({ helperId: waiting.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await helpersOf(botId))[0]?.status).toBe("waiting");
  });

  it("tells the Helper when its Computer was rebuilt while it waited", async () => {
    const { client, botId, helperFake, computerFake } = await botWith(
      [handsOff, round(), round()],
      [asksUser, round(text("I have to start over."))],
    );
    await send(client, botId, "what deals are on my dashboard?");
    const waiting = await statusIs(botId, "waiting");

    computerFake.lose(computerFake.callsOf("create").at(-1)!.sandboxId);
    await client.helpers.done({ helperId: waiting.id });
    await statusIs(botId, "complete");

    const input = (helperFake.calls[1]?.messages ?? []) as ModelMessage[];
    expect(askUserAnswer(input)).toEqual({
      result: handOffAnswers.done,
      note: handOffAnswers.rebuilt,
    });
  });

  it("counts only running time against its 30 minutes", async () => {
    let offsetMs = 0;
    const { client, botId } = await botWith(
      [handsOff, round(), round()],
      [asksUser, round(text("There are 3 deals."))],
      { clock: () => new Date(Date.now() + offsetMs) },
    );
    await send(client, botId, "what deals are on my dashboard?");
    const waiting = await statusIs(botId, "waiting");

    // The user answers two hours later.
    offsetMs = 2 * 60 * 60_000;
    await client.helpers.done({ helperId: waiting.id });
    const done = await statusIs(botId, "complete");

    expect(done.report).toBe("There are 3 deals.");
  });
});
