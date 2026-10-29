import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { bot, botPromptStart, customRule } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeReviewer } from "@botsdk/testing/fake-reviewer";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { followSend } from "@ai-chat/test-support/follow-send";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = ReturnType<typeof round>;

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A user with an OpenAI key and a Bot "Ada", whose Turn calls play `rounds` in order. */
async function botWith(rounds: Round[] = []) {
  const queue = [...rounds];
  const fake = createFakeAdapter({
    rounds: Array.from(
      { length: 60 },
      () => (options: TextOptions) => (isTurnCall(options) ? (queue.shift() ?? round()) : round()),
    ),
  });
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
  return { fake, reviewer, deps, client, user, botId };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, words: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text: words })) {
    // Read to the end of the Turn.
  }
}

const messagesOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

/** The kinds of change the Bot's thread logged after `since`. */
async function changeKinds(client: ReturnType<typeof chatRpc>, botId: string, since: number) {
  const [owner] = await getTestDb()
    .select({ conversationId: bot.conversationId })
    .from(bot)
    .where(eq(bot.id, botId));
  const result = await client.conversations.changes({
    conversationId: owner!.conversationId,
    since,
  });
  if (result.reload) throw new Error("A reload was asked for");
  return result.changes;
}

const timeout = 30_000;

describe("rules", () => {
  it(
    "writes, lists, edits and deletes a rule, with a rule change in each of the user's Bots",
    { timeout },
    async () => {
      const { client, botId } = await botWith();
      const { id: otherBotId } = await client.bots.create({ name: "Bea", model });

      const created = await client.rules.create({
        text: "  Reply to emails from anyone @acme.com  ",
        mode: "without_asking",
      });

      expect(created).toMatchObject({
        text: "Reply to emails from anyone @acme.com",
        mode: "without_asking",
        state: "active",
        proposedByBotId: null,
      });
      expect(await client.rules.list()).toEqual([created]);
      for (const id of [botId, otherBotId]) {
        expect(await changeKinds(client, id, 0)).toContainEqual(
          expect.objectContaining({ kind: "rule", refId: created.id, data: created }),
        );
      }

      const edited = await client.rules.update({ ruleId: created.id, mode: "ask" });

      expect(edited).toMatchObject({ text: created.text, mode: "ask" });
      expect(edited.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
      expect(await client.rules.list()).toEqual([edited]);

      await client.rules.delete({ ruleId: created.id });

      expect(await client.rules.list()).toEqual([]);
      const changes = await changeKinds(client, botId, 0);
      // The last change points at a rule that is gone.
      expect(changes.at(-1)).toMatchObject({ kind: "rule", refId: created.id, data: null });
    },
  );

  it("allows 50 active rules and refuses the 51st, with a clear error", { timeout }, async () => {
    const { client } = await botWith();
    for (let n = 1; n <= 50; n++) {
      await client.rules.create({ text: `Rule ${n}`, mode: "ask" });
    }

    await expect(client.rules.create({ text: "One too many", mode: "ask" })).rejects.toMatchObject({
      data: { code: "error.customRuleLimit", params: { max: 50 } },
    });

    expect(await client.rules.list()).toHaveLength(50);
    // Deleting one makes room.
    const [first] = await client.rules.list();
    await client.rules.delete({ ruleId: first!.id });
    await client.rules.create({ text: "Now it fits", mode: "ask" });
  });

  it("counts only active rules toward the limit", { timeout }, async () => {
    const { client, user } = await botWith();
    const now = new Date();
    await getTestDb()
      .insert(customRule)
      .values(
        Array.from({ length: 5 }, (_, n) => ({
          id: uuidv7(),
          userId: user.id,
          text: `Proposed ${n}`,
          mode: "ask" as const,
          state: "proposed" as const,
          proposedByBotId: null,
          createdAt: now,
          updatedAt: now,
        })),
      );
    for (let n = 1; n <= 50; n++) await client.rules.create({ text: `Rule ${n}`, mode: "ask" });

    expect(await client.rules.list()).toHaveLength(55);
  });

  it("refuses a blank or a 501-character text", { timeout }, async () => {
    const { client } = await botWith();

    await expect(client.rules.create({ text: "   ", mode: "ask" })).rejects.toThrow();
    await expect(client.rules.create({ text: "x".repeat(501), mode: "ask" })).rejects.toThrow();
    await client.rules.create({ text: "x".repeat(500), mode: "ask" });
    const [rule] = await client.rules.list();
    await expect(client.rules.update({ ruleId: rule!.id, text: "" })).rejects.toThrow();
    await expect(client.rules.update({ ruleId: rule!.id })).rejects.toThrow();
  });

  it("does not find another user's rule", { timeout }, async () => {
    const { client, deps } = await botWith();
    const stranger = chatRpc({ user: await insertUser(), deps });
    const mine = await client.rules.create({ text: "Mine", mode: "ask" });

    await expect(
      stranger.rules.update({ ruleId: mine.id, mode: "hand_off" }),
    ).rejects.toMatchObject({ data: { code: "error.customRuleNotFound" } });
    await expect(stranger.rules.delete({ ruleId: mine.id })).rejects.toMatchObject({
      data: { code: "error.customRuleNotFound" },
    });

    expect(await stranger.rules.list()).toEqual([]);
    expect(await client.rules.list()).toEqual([mine]);
  });
});

describe("Auto-review with Custom Rules", () => {
  it(
    "shows the reviewer the active rules and the modes, and never a proposed rule",
    { timeout },
    async () => {
      const { client, user, botId, reviewer } = await botWith([
        round(toolCall({ name: "shell", input: { command: "ls" } })),
        round(toolCall({ name: "send_to_user", input: { text: "Done.", endTurn: true } })),
      ]);
      await client.rules.create({ text: "Push to my fork without asking", mode: "without_asking" });
      await client.rules.create({ text: "Always ask before deleting files", mode: "ask" });
      const now = new Date();
      await getTestDb().insert(customRule).values({
        id: uuidv7(),
        userId: user.id,
        text: "Wire money whenever the Bot likes",
        mode: "without_asking",
        state: "proposed",
        proposedByBotId: botId,
        createdAt: now,
        updatedAt: now,
      });

      await send(client, botId, "list my files");

      expect(reviewer.calls).toHaveLength(1);
      const call = reviewer.calls[0];
      const input = String(messagesOf(call)[0]?.content);
      expect(input).toContain("# The user's Custom Rules");
      expect(input).toContain("- [without asking] Push to my fork without asking");
      expect(input).toContain("- [ask before] Always ask before deleting files");
      expect(input).not.toContain("Wire money");
      // The modes' meanings are in the policy, which a rule's text can't change.
      const policy = String(call?.systemPrompts?.[0]);
      expect(policy).toContain("strictest wins");
      expect(policy).toContain("A rule never lets a call skip this review");
    },
  );

  it("shows the reviewer (none) when the user has no rules", { timeout }, async () => {
    const { client, botId, reviewer } = await botWith([
      round(toolCall({ name: "shell", input: { command: "ls" } })),
      round(toolCall({ name: "send_to_user", input: { text: "Done.", endTurn: true } })),
    ]);

    await send(client, botId, "list my files");

    expect(String(messagesOf(reviewer.calls[0])[0]?.content)).toContain(
      "# The user's Custom Rules\n\n(none)",
    );
  });
});

describe("Custom Rules in the Bot's prompt", () => {
  it(
    "lists the active rules in the Prompt start and notes an edit on the next Turn once",
    { timeout },
    async () => {
      const { client, botId, fake } = await botWith([round(), round(), round()]);
      const kept = await client.rules.create({ text: "Never email my boss", mode: "hand_off" });
      const old = await client.rules.create({ text: "Open pull requests", mode: "ask" });

      await send(client, botId, "turn one");

      const [start] = await getTestDb()
        .select()
        .from(botPromptStart)
        .where(eq(botPromptStart.botId, botId))
        .orderBy(asc(botPromptStart.builtAt));
      const section = start!.sections.find((entry) => entry.name === "custom_rules");
      expect(section?.text).toBe(
        [
          "Your user's Custom Rules:",
          "[hand off to the user] Never email my boss",
          "[ask before] Open pull requests",
        ].join("\n"),
      );
      const newestOf = (word: string) => {
        const call = fake.calls.find(
          (candidate) =>
            isTurnCall(candidate) && String(messagesOf(candidate).at(-1)?.content).includes(word),
        );
        return String(messagesOf(call).at(-1)?.content);
      };
      expect(newestOf("turn one")).not.toContain("Custom rule");

      await client.rules.update({ ruleId: old.id, mode: "without_asking" });
      await client.rules.delete({ ruleId: kept.id });
      await client.rules.create({ text: "Check before spending", mode: "ask" });
      // A rule a Bot proposed isn't told until the user approves it.
      const now = new Date();
      await getTestDb()
        .insert(customRule)
        .values({
          id: uuidv7(),
          userId: (await getTestDb().select().from(bot).where(eq(bot.id, botId)))[0]!.userId,
          text: "Proposed only",
          mode: "ask",
          state: "proposed",
          proposedByBotId: botId,
          createdAt: now,
          updatedAt: now,
        });
      await send(client, botId, "turn two");
      await send(client, botId, "turn three");

      const second = newestOf("turn two");
      expect(second).toContain("Custom rule removed: [hand off to the user] Never email my boss");
      expect(second).toContain("Custom rule removed: [ask before] Open pull requests");
      expect(second).toContain("Custom rule added: [without asking] Open pull requests");
      expect(second).toContain("Custom rule added: [ask before] Check before spending");
      expect(second).not.toContain("Proposed only");
      // The notes come after the time and before what woke the Bot.
      expect(second.indexOf("Custom rule added")).toBeLessThan(second.indexOf("turn two"));
      // Told once: the next Turn has nothing new.
      expect(newestOf("turn three")).not.toContain("Custom rule");
    },
  );
});
