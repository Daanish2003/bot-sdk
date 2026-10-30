import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botReview, botRoutine, botTrigger, customRule, linkedIdentity } from "../../src/storage";
import { maxActiveCustomRules } from "@botsdk/client/bot/rule";
import { appendBotMessage, controlParts, findBot } from "../../src/bot/conversation";
import { sentFileBlobKey } from "../../src/bot/conversation/files";
import { uuidv7 } from "../../src/lib/uuidv7";
import { emailChannel } from "../../src/channel";
import { fakeEmailProvider, fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import { saveCredentials } from "../../src/models/internal";
import type { BotSdkPlugin } from "../../src/plugin";
import { inProcessRunner, type JobRunner, claimJob } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import type { RichControl } from "@botsdk/client/bot/rich-control";

/*
 * A Bot's Rich controls on a messaging Channel (spec #1044, ticket #1049), through the fake
 * messaging adapter: a choice and an Approval as buttons that also take typed replies, a Secret
 * request as a link only, files as documents, and an answer given there showing in the app.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const poll = { timeout: 10_000 };
const at = new Date("2026-10-22T09:00:00.000Z");
const appUrl = "https://app.example";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: { jobs: JobRunner; part: BotSdkPlugin; deps: TestDeps }[] = [];

afterEach(async () => {
  for (const { jobs, part, deps } of started.splice(0)) {
    await part.stop!(deps);
    await jobs.stop();
  }
});

const says = (text: string, more: Record<string, unknown> = {}) =>
  toolCall({ name: "send_to_user", input: { text, endTurn: true, ...more } });

const asks = (other = false) =>
  says("Which color?", { choice: { options: ["Red", "Blue", "Green"], other } });

const routine = {
  name: "morning-brief",
  prompt: "Summarize today's calendar.",
  schedule: { days: ["mon", "tue", "wed", "thu", "fri"], times: ["08:00"] },
};

const rule = { text: "Open pull requests without asking", mode: "without_asking", why: "Often." };

/**
 * A Bot whose Model plays `rounds`, its Channel account `@bot_1` on the fake `telegram` platform and
 * its user Linked as platform user `1001`, on an idle runner and a fixed clock, with an email Channel
 * for the app's URL.
 */
async function telegramBot(rounds: Round[]) {
  const timer = fakeJobClock(at);
  const brain = createFakeAdapter({ rounds });
  const fake = fakeMessagingAdapter({ id: "telegram" });
  const logged: string[] = [];
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  const user = await insertUser();
  deps = createTestSdk({
    channels: [
      fake.adapter,
      emailChannel({ provider: fakeEmailProvider().provider, domain: "bots.example", appUrl }),
    ],
    jobs,
    adapterFor: () => brain.adapter,
    clock: timer.clock.now,
    logger: { error: (text: unknown) => void logged.push(String(text)) },
    memory: false,
  });
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada Lovelace", model });
  const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
  await client.channels.accounts.save({
    botId,
    platform: "telegram",
    credentials: { token: "1:secret" },
  });
  await getTestDb().insert(linkedIdentity).values({
    id: uuidv7(),
    userId: user.id,
    platform: "telegram",
    platformUserId: "1001",
    handle: "@ada",
    workspaceId: null,
    linkedAt: at,
  });
  const part = deps.parts.all.find((candidate) => candidate.id === "channel")!;
  await part.start!(deps);
  started.push({ jobs, part, deps });
  await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(true);

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  const settleRuns = async () => {
    timer.advance(3_000);
    await runDue();
  };
  /** The user writes to the Bot on Telegram, and the Turn it starts runs. */
  const write = async (text: string) => {
    await fake.deliver("@bot_1", { sourceId: `1001:${uuidv7()}`, text });
    await settleRuns();
  };
  /** The user presses a button of the message they were sent, and what it starts runs. */
  const press = async (control: string, option: string, messageId = "1") => {
    await fake.deliver("@bot_1", {
      sourceId: uuidv7(),
      press: { control, option, messageId },
    });
    await settleRuns();
  };
  /** A Message the Bot posts with no Turn, which goes where the user's settings send it. */
  const post = async (text: string, control?: RichControl) => {
    await client.notifications.update({
      quietHours: null,
      urgent: null,
      other: "telegram",
    });
    await deps!.db.transaction((tx) =>
      appendBotMessage(deps!, tx, conversationId, {
        parts: control
          ? controlParts(text, control)
          : { schemaVersion: 1, parts: [{ type: "text", text }] },
        createdAt: timer.clock.now(),
        turnId: null,
      }),
    );
    await runDue();
  };
  const messages = async () => (await client.bots.get({ botId })).messages;
  const newest = async (kind: string) =>
    (await messages()).findLast((sent) => sent.control?.kind === kind)!;
  const triggers = () =>
    getTestDb()
      .select()
      .from(botTrigger)
      .where(eq(botTrigger.conversationId, conversationId))
      .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id));
  /** Stops the listener and starts it again, as a restart in-process does. */
  const restart = async () => {
    await part.stop!(deps!);
    await part.start!(deps!);
    await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(true);
  };
  return {
    fake,
    deps,
    timer,
    restart,
    client,
    user,
    botId,
    conversationId,
    write,
    press,
    post,
    messages,
    newest,
    triggers,
    logged,
    settleRuns,
  };
}

describe("a choice", () => {
  it("is sent with a numbered list and one button per option, plus Other when offered", async () => {
    const { write, fake, newest } = await telegramBot([round(asks(true))]);

    await write("Pick one for me");

    const asked = await newest("choice");
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.message).toMatchObject({
      chatId: "1001",
      text: "Which color?\n\n1. Red\n2. Blue\n3. Green\n4. Other: reply with your own answer",
      buttons: {
        control: asked.id,
        options: [
          { option: "0", label: "Red" },
          { option: "1", label: "Blue" },
          { option: "2", label: "Green" },
          { option: "other", label: "Other" },
        ],
      },
    });
  });

  it("has no Other button when the Bot offered none", async () => {
    const { write, fake } = await telegramBot([round(asks())]);

    await write("Pick one for me");

    expect(fake.sends[0]!.message.buttons!.options.map((one) => one.label)).toEqual([
      "Red",
      "Blue",
      "Green",
    ]);
  });

  it("is answered by a press the way the app's choose answers, and the buttons show the choice", async () => {
    const { write, press, fake, newest, triggers, client, botId } = await telegramBot([
      round(asks()),
      round(says("Blue it is.")),
    ]);
    await write("Pick one for me");
    const asked = await newest("choice");

    await press(asked.id, "1", "55");

    expect((await newest("choice")).control).toMatchObject({
      kind: "choice",
      answer: { text: "Blue", other: false },
    });
    expect(fake.edits).toEqual([
      expect.objectContaining({ target: { chatId: "1001", messageId: "55", chosen: "Blue" } }),
    ]);
    // The same Trigger the app's choose queues, on this Channel.
    expect((await triggers()).find((trigger) => trigger.id === `action:${asked.id}`)).toMatchObject(
      {
        channel: "telegram",
        source: "user",
      },
    );
    expect(fake.sends.at(-1)!.message.text).toBe("Blue it is.");
    // The app answers nothing more on it.
    await expect(
      client.bots.choose({ botId, messageId: asked.id, answer: { option: "Red" } }),
    ).rejects.toThrow();
  });

  it("refuses a second press, and the buttons keep the first answer", async () => {
    const { write, press, fake, newest, triggers } = await telegramBot([
      round(asks()),
      round(says("Blue it is.")),
    ]);
    await write("Pick one for me");
    const asked = await newest("choice");
    await press(asked.id, "1", "55");

    await press(asked.id, "0", "55");

    expect((await newest("choice")).control).toMatchObject({ answer: { text: "Blue" } });
    expect((await triggers()).filter((trigger) => trigger.id.startsWith("action:"))).toHaveLength(
      1,
    );
    expect(fake.edits.map((edit) => edit.target.chosen)).toEqual(["Blue", "Blue"]);
  });

  it("is answered by a typed number", async () => {
    const { write, newest } = await telegramBot([round(asks()), round(says("ok"))]);
    await write("Pick one for me");
    await write("3");
    expect((await newest("choice")).control).toMatchObject({
      answer: { text: "Green", other: false },
    });
  });

  it("is answered by the option's exact text", async () => {
    const { write, newest } = await telegramBot([round(asks()), round(says("ok"))]);
    await write("Pick one for me");
    await write("Red");
    expect((await newest("choice")).control).toMatchObject({ answer: { text: "Red" } });
  });

  it("treats any other text as an ordinary Message and stays open", async () => {
    const { write, newest, messages, triggers } = await telegramBot([
      round(asks()),
      round(says("Noted.")),
    ]);
    await write("Pick one for me");

    await write("purple, actually");
    await write("9");

    expect((await newest("choice")).control).not.toHaveProperty("answer");
    const sent = (await messages()).filter((one) => one.role === "user").map((one) => one.text);
    expect(sent).toContain("purple, actually");
    expect(sent).toContain("9");
    expect((await triggers()).some((trigger) => trigger.id.startsWith("action:"))).toBe(false);
  });

  it("takes the user's own text after Other", async () => {
    const { write, press, fake, newest } = await telegramBot([
      round(asks(true)),
      round(says("Teal, then.")),
    ]);
    await write("Pick one for me");
    const asked = await newest("choice");

    await press(asked.id, "other");
    expect(fake.sends.at(-1)!.message.text).toBe("Type your answer.");
    // Not an option, and not an ordinary Message: the answer.
    await write("1");

    expect((await newest("choice")).control).toMatchObject({
      answer: { text: "1", other: true },
    });
  });

  it("is answered once: a typed number after the answer is an ordinary Message", async () => {
    const { write, press, newest, messages } = await telegramBot([
      round(asks()),
      round(says("Blue it is.")),
      round(says("Noted.")),
    ]);
    await write("Pick one for me");
    const asked = await newest("choice");
    await press(asked.id, "1");

    await write("2");

    expect((await newest("choice")).control).toMatchObject({ answer: { text: "Blue" } });
    expect((await messages()).some((one) => one.role === "user" && one.text === "2")).toBe(true);
  });

  it("is not answered by a press from another sender or a group chat", async () => {
    const { write, fake, newest } = await telegramBot([round(asks())]);
    await write("Pick one for me");
    const asked = await newest("choice");

    await fake.deliver("@bot_1", {
      sender: { id: "2002", handle: "@eve" },
      press: { control: asked.id, option: "0", messageId: "1" },
    });
    await fake.deliver("@bot_1", {
      chat: { id: "-5", private: false },
      press: { control: asked.id, option: "0", messageId: "1" },
    });

    expect((await newest("choice")).control).not.toHaveProperty("answer");
    expect(fake.edits).toEqual([]);
  });
  it("closes its buttons on a typed answer, as a press does", async () => {
    const { write, fake, newest } = await telegramBot([round(asks()), round(says("ok"))]);
    await write("Pick one for me");
    const shown = fake.sends.find((one) => one.message.buttons)!.sent.buttonsMessageId!;

    await write("3");

    expect((await newest("choice")).control).toMatchObject({ answer: { text: "Green" } });
    expect(fake.edits.map((edit) => edit.target)).toEqual([
      { chatId: "1001", messageId: shown, chosen: "Green" },
    ]);
  });

  it("takes a typed answer it refuses (a paused Bot) as an ordinary Message, skipped", async () => {
    const { write, newest, client, botId, triggers } = await telegramBot([round(asks())]);
    await write("Pick one for me");
    await client.bots.pause({ botId });

    await write("2");

    expect((await newest("choice")).control).not.toHaveProperty("answer");
    expect(
      (await triggers())
        .filter((trigger) => trigger.skipReason)
        .map((trigger) => [trigger.channel, trigger.skipReason]),
    ).toEqual([["telegram", "paused"]]);
  });

  it("forgets a wait for the Other text after 10 minutes", async () => {
    const { write, press, timer, newest } = await telegramBot([
      round(asks(true)),
      round(says("Red, then.")),
    ]);
    await write("Pick one for me");
    const asked = await newest("choice");
    await press(asked.id, "other");

    timer.advance(10 * 60_000 + 1);
    await write("1");

    expect((await newest("choice")).control).toMatchObject({
      answer: { text: "Red", other: false },
    });
  });

  it("acts once on a resent typed answer, also after the listener restarts", async () => {
    const { write, fake, messages, restart, settleRuns } = await telegramBot([
      round(asks()),
      round(asks()),
    ]);
    await write("Pick one for me");
    const typed = { sourceId: "1001:typed", text: "1" };
    await fake.deliver("@bot_1", typed);
    await settleRuns();
    await restart();

    await fake.deliver("@bot_1", typed);
    await settleRuns();

    const choices = (await messages()).filter((one) => one.control?.kind === "choice");
    expect(choices).toHaveLength(2);
    expect(choices[0]!.control).toMatchObject({ answer: { text: "Red" } });
    expect(choices[1]!.control).not.toHaveProperty("answer");
  });

  it("acts once on a resent press", async () => {
    const { write, fake, newest, settleRuns } = await telegramBot([
      round(asks()),
      round(says("Blue it is.")),
    ]);
    await write("Pick one for me");
    const asked = await newest("choice");
    const pressed = {
      sourceId: "press-1",
      press: { control: asked.id, option: "1", messageId: "55" },
    };
    await fake.deliver("@bot_1", pressed);
    await settleRuns();

    await fake.deliver("@bot_1", pressed);

    expect(fake.edits).toHaveLength(1);
  });

  it("acts once on two copies of a press delivered at the same time", async () => {
    const { write, fake, newest, logged } = await telegramBot([
      round(asks()),
      round(says("Blue it is.")),
    ]);
    await write("Pick one for me");
    const asked = await newest("choice");
    const pressed = {
      sourceId: "press-2",
      press: { control: asked.id, option: "1", messageId: "56" },
    };

    await Promise.all([fake.deliver("@bot_1", pressed), fake.deliver("@bot_1", pressed)]);

    expect(fake.edits).toHaveLength(1);
    expect(logged).toEqual([]);
  });
});

describe("an Approval", () => {
  const routining = () => [
    round(toolCall({ name: "create_routine", input: routine })),
    round(says("Waiting for you.")),
  ];
  const proposing = () => [
    round(toolCall({ name: "propose_rule", input: rule })),
    round(says("Proposed.")),
  ];
  const routinesOf = (botId: string) =>
    getTestDb().select().from(botRoutine).where(eq(botRoutine.botId, botId));

  it("is sent with Approve and Deny buttons", async () => {
    const { write, fake, newest } = await telegramBot(routining());

    await write("Brief me every weekday");

    const asked = await newest("routine_approval");
    const approval = fake.sends.find((sent) => sent.message.buttons)!;
    expect(approval.message.buttons).toEqual({
      control: asked.id,
      options: [
        { option: "approve", label: "Approve" },
        { option: "deny", label: "Deny" },
      ],
    });
    expect(approval.message.text).toContain('Routine "morning-brief" waits for your approval.');
  });

  it("is approved by a button, as in the app, and the buttons say so", async () => {
    const { write, press, fake, newest, botId, client } = await telegramBot(routining());
    await write("Brief me every weekday");
    const asked = await newest("routine_approval");

    await press(asked.id, "approve", "7");

    expect(await routinesOf(botId)).toEqual([expect.objectContaining({ state: "active" })]);
    expect((await client.routines.list({ botId }))[0]).toMatchObject({ state: "active" });
    expect(fake.edits.at(-1)!.target).toEqual({
      chatId: "1001",
      messageId: "7",
      chosen: "Approved",
    });
  });

  it("is denied by a button, which deletes the Routine", async () => {
    const { write, press, fake, newest, botId } = await telegramBot(routining());
    await write("Brief me every weekday");
    const asked = await newest("routine_approval");

    await press(asked.id, "deny", "7");

    expect(await routinesOf(botId)).toEqual([]);
    expect(fake.edits.at(-1)!.target.chosen).toBe("Denied");
  });

  it("is approved by a typed yes, in any case", async () => {
    const { write, botId } = await telegramBot(routining());
    await write("Brief me every weekday");
    await write("Yes");
    expect(await routinesOf(botId)).toEqual([expect.objectContaining({ state: "active" })]);
  });

  it("is denied by a typed no", async () => {
    const { write, botId } = await telegramBot(routining());
    await write("Brief me every weekday");
    await write("no");
    expect(await routinesOf(botId)).toEqual([]);
  });

  it("treats yes as an ordinary Message when nothing waits", async () => {
    const { write, messages } = await telegramBot([round(says("Hello.")), round(says("Hi."))]);
    await write("Hello");

    await write("yes");

    expect((await messages()).some((one) => one.role === "user" && one.text === "yes")).toBe(true);
  });

  it("closes its buttons on a typed yes, as a press does", async () => {
    const { write, fake } = await telegramBot(routining());
    await write("Brief me every weekday");
    const shown = fake.sends.find((one) => one.message.buttons)!.sent.buttonsMessageId!;

    await write("yes");

    expect(fake.edits.map((edit) => edit.target)).toEqual([
      { chatId: "1001", messageId: shown, chosen: "Approved" },
    ]);
  });

  it("of a webhook Routine says it was approved and links to the app for the URL, never the token", async () => {
    const { write, press, fake, newest, botId } = await telegramBot([
      round(
        toolCall({
          name: "create_routine",
          input: { name: "payouts", prompt: "Check the payout.", webhook: true },
        }),
      ),
      round(says("Waiting for you.")),
    ]);
    await write("Watch my payouts webhook");
    const asked = await newest("routine_approval");

    await press(asked.id, "approve", "7");

    const [routine] = await routinesOf(botId);
    expect(routine).toMatchObject({ state: "active" });
    expect(fake.sends.at(-1)!.message.text).toBe(
      `Approved. [Get its webhook URL in the app](${appUrl}/bots/${botId})`,
    );
    expect(fake.sends.some((one) => one.message.text.includes("/routines/webhook/"))).toBe(false);
  });

  it("of a webhook Routine is taken once, though the notice after it fails to send", async () => {
    const { write, fake, newest, logged, settleRuns } = await telegramBot([
      round(
        toolCall({
          name: "create_routine",
          input: { name: "payouts", prompt: "Check the payout.", webhook: true },
        }),
      ),
      round(says("Waiting for you.")),
    ]);
    await write("Watch my payouts webhook");
    const asked = await newest("routine_approval");
    const pressed = {
      sourceId: uuidv7(),
      press: { control: asked.id, option: "approve", messageId: "7" },
    };
    fake.counts.sendFailures = 1;

    await fake.deliver("@bot_1", pressed);
    await settleRuns();
    await fake.deliver("@bot_1", pressed);
    await settleRuns();

    expect(fake.edits.map((edit) => edit.target.chosen)).toEqual(["Approved"]);
    expect(logged.some((line) => line.includes("webhook"))).toBe(true);
  });

  it("is not answered by another sender or from a group chat", async () => {
    const { write, fake, newest, botId } = await telegramBot(routining());
    await write("Brief me every weekday");
    const asked = await newest("routine_approval");

    await fake.deliver("@bot_1", {
      sender: { id: "2002", handle: "@eve" },
      press: { control: asked.id, option: "approve", messageId: "1" },
    });
    await fake.deliver("@bot_1", {
      sender: { id: "2002", handle: "@eve" },
      text: "yes",
    });
    await fake.deliver("@bot_1", {
      chat: { id: "-5", private: false },
      press: { control: asked.id, option: "approve", messageId: "1" },
    });
    await fake.deliver("@bot_1", { chat: { id: "-5", private: false }, text: "yes" });

    expect(await routinesOf(botId)).toEqual([expect.objectContaining({ state: "pending" })]);
  });

  it("covers a proposed rule approved by a button", async () => {
    const { write, press, newest, client } = await telegramBot(proposing());
    await write("I keep approving these");
    await press((await newest("rule_approval")).id, "approve");
    expect(await client.rules.list()).toEqual([expect.objectContaining({ state: "active" })]);
  });

  it("covers a proposed rule denied by a typed no", async () => {
    const { write, client } = await telegramBot(proposing());
    await write("I keep approving these");
    await write("no");
    expect(await client.rules.list()).toEqual([]);
  });

  it("drops a typed yes the domain refuses for another reason, never passing it to the Model", async () => {
    const { write, client, user, messages } = await telegramBot(proposing());
    await write("I keep approving these");
    const now = new Date();
    await getTestDb()
      .insert(customRule)
      .values(
        Array.from({ length: maxActiveCustomRules }, (_, index) => ({
          id: uuidv7(),
          userId: user.id,
          text: `Rule ${index}`,
          mode: "without_asking" as const,
          state: "active" as const,
          createdAt: now,
          updatedAt: now,
        })),
      );

    await write("yes");

    expect((await messages()).some((one) => one.role === "user" && one.text === "yes")).toBe(false);
    expect((await client.rules.list()).filter((one) => one.state === "proposed")).toHaveLength(1);
  });

  it("covers a review's Approval, and a closed one says so", async () => {
    const { post, press, newest, botId, fake, write } = await telegramBot([round(says("Hi."))]);
    await write("Hello");
    const reviewId = uuidv7();
    await getTestDb()
      .insert(botReview)
      .values({
        id: reviewId,
        botId,
        toolCallId: "call-1",
        tool: "shell",
        input: { command: "make deploy" },
        summary: "Deploy",
        verdict: "block",
        reason: "You didn't ask to deploy.",
        state: "waiting",
        deadline: new Date(at.getTime() + 60_000),
        createdAt: at,
      });
    await post("Deploy", { kind: "review_approval", reviewId });
    const asked = await newest("review_approval");
    expect(fake.sends.at(-1)!.message.buttons!.control).toBe(asked.id);

    await press(asked.id, "approve", "9");
    await press(asked.id, "deny", "9");

    const [review] = await getTestDb().select().from(botReview).where(eq(botReview.id, reviewId));
    expect(review).toMatchObject({ state: "allowed" });
    expect(fake.edits.map((edit) => edit.target.chosen)).toEqual(["Approved", "Already answered"]);
  });
});

describe("other Rich controls", () => {
  it("send a Secret request as text and a link, never answerable there", async () => {
    const { post, press, newest, fake, botId, write } = await telegramBot([
      round(says("Hi.")),
      round(says("Hello.")),
    ]);
    await write("Hello");

    await post("I need your token.", {
      kind: "secret",
      name: "GITHUB_TOKEN",
      why: "To open pull requests.",
    });

    const message = fake.sends.at(-1)!.message;
    expect(message.text).toBe(
      `I need your token.\n\n[Enter it securely in the app](${appUrl}/bots/${botId})`,
    );
    expect(message.buttons).toBeUndefined();
    // A press of anything at it, or a typed value, is nothing but an ordinary Message.
    await press((await newest("secret")).id, "0");
    await write("hunter2");
    expect(fake.edits).toEqual([]);
  });

  it("send the Computer and Show me cards as one line and a link", async () => {
    const { post, fake, botId, write } = await telegramBot([round(says("Hi."))]);
    await write("Hello");

    await post("I need you to take over.", {
      kind: "computer",
      helperId: uuidv7(),
      reason: "Log in",
      state: "open",
    });

    expect(fake.sends.at(-1)!.message.text).toBe(
      `I need you to take over.\n\n[Take over the Computer in the app](${appUrl}/bots/${botId})`,
    );
  });

  it("send files as documents within the adapter's limit, with no text needed", async () => {
    const { post, fake, deps, write } = await telegramBot([round(says("Hi."))]);
    await write("Hello");
    const file = { id: uuidv7(), name: "report.csv", size: 5, mediaType: "text/csv" };
    await deps.blobStore.put(sentFileBlobKey(file.id), new TextEncoder().encode("a,b\n1"), {
      contentType: file.mediaType,
    });

    await post("", { kind: "files", files: [file] });

    const message = fake.sends.at(-1)!.message;
    expect(message.text).toBe("");
    expect(message.files).toEqual([
      { name: "report.csv", contentType: "text/csv", content: Buffer.from("a,b\n1") },
    ]);
  });

  it("link the files past the adapter's limit to the app", async () => {
    const { post, fake, deps, botId, write } = await telegramBot([round(says("Hi."))]);
    await write("Hello");
    fake.adapter.limits.upload = 3;
    const file = { id: uuidv7(), name: "report.csv", size: 5, mediaType: "text/csv" };
    await deps.blobStore.put(sentFileBlobKey(file.id), new TextEncoder().encode("a,b\n1"), {
      contentType: file.mediaType,
    });

    await post("Here you go.", { kind: "files", files: [file] });

    const message = fake.sends.at(-1)!.message;
    expect(message.files).toBeUndefined();
    expect(message.text).toBe(
      `Here you go.\n\n- report.csv\n\n[Download in the app](${appUrl}/bots/${botId})`,
    );
  });
});
