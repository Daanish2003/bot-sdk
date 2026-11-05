import type { TextOptions } from "@tanstack/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner, systemClock } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { followSend } from "@ai-chat/test-support/follow-send";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { bot, botTurn } from "@botsdk/bot/storage";
import { eq } from "drizzle-orm";
import { representative } from "../src";
import { factProposalTools } from "../src/server/fact-proposals";

/*
 * A Bot proposing a Published fact (ticket #1264): real Bot Turns with a fake Model on real Postgres,
 * read through the owner's API. Nothing changes until the owner says yes on the Facts page.
 */

vi.setConfig({ testTimeout: 30_000 });

const botModel = "openai:gpt-5.4-mini";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const dayMs = 24 * 60 * 60 * 1000;

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const proposes = (args: Record<string, unknown>) =>
  round(
    toolCall({
      name: "run_tool",
      input: { name: "propose_fact", args: { why: "The price list changed.", ...args } },
    }),
  );
const quiet = () => round();

const price = { key: "price.haircut", type: "money", topic: "Prices", value: "45 USD" } as const;

async function instance(
  rounds: Round[],
  { features = [representative()] }: { features?: ReturnType<typeof representative>[] } = {},
) {
  const queue = [...rounds];
  const botFake = createFakeAdapter({
    rounds: Array.from({ length: 40 }, () => (call: TextOptions) => {
      const next = queue.shift() ?? quiet();
      return typeof next === "function" ? next(call) : next;
    }),
  });
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: { ...systemClock, now },
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features,
    adapterFor: () => botFake.adapter,
    clock: now,
    memory: false,
  });
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
  const { id: botId } = await rpc.bots.create({ name: "Ada", model: botModel });
  const send = async (text: string) => {
    for await (const _event of await followSend(rpc, { botId, id: uuidv7(), text })) {
      // Read to the end of the Turn.
    }
  };
  return {
    botFake,
    deps,
    user,
    rpc,
    botId,
    send,
    script: (more: Round[]) => void queue.push(...more),
    later: (ms: number) => void (offset += ms),
  };
}

type Instance = Awaited<ReturnType<typeof instance>>;

const toolResults = (fake: Instance["botFake"]) =>
  JSON.stringify((fake.calls.at(-1)?.messages ?? []).filter((message) => message.role === "tool"));

const cardsOf = async ({ rpc, botId }: Instance) =>
  (await rpc.bots.get({ botId })).messages.filter(
    (message) => message.control?.kind === "fact_approval",
  );

const wakes = ({ botFake }: Instance) => [
  ...new Set(
    botFake.calls.flatMap((call: TextOptions) =>
      (call.messages ?? [])
        .map((message) => String(message.content))
        .filter((content) => content.includes("[Approval]")),
    ),
  ),
];

/** An owner with the price fact, whose Bot has proposed it become 50 USD. */
async function proposed() {
  const made = await instance([proposes({ key: price.key, value: "50 USD" }), quiet()]);
  await made.rpc.representative.factAdd(price);
  await made.send("Raise the haircut price");
  const [proposal] = await made.rpc.representative.factProposals();
  return { ...made, proposal: proposal! };
}

const valueOf = async ({ rpc }: Instance) =>
  (await rpc.representative.factList()).find((fact) => fact.key === price.key)?.value;

describe("a Bot's proposed fact", () => {
  it("changes nothing until the owner says yes, and shows both values", async () => {
    const made = await proposed();

    expect(await valueOf(made)).toBe("45 USD");
    expect(made.proposal).toMatchObject({
      key: price.key,
      botName: "Ada",
      why: "The price list changed.",
      current: { value: "45 USD", topic: "Prices", type: "money" },
      proposed: { value: "50 USD", topic: "Prices", type: "money" },
    });
    expect(await made.rpc.representative.factLog()).toHaveLength(1);
  });

  it("reaches the owner as a link-only card in the Bot's Conversation", async () => {
    const made = await proposed();

    const [card, ...rest] = await cardsOf(made);
    expect(rest).toEqual([]);
    expect(card!.control).toMatchObject({
      kind: "fact_approval",
      key: price.key,
      path: "/facts",
    });
    expect(card!.control).not.toHaveProperty("answer");
    expect(card!.text).toContain("50 USD");
    expect(card!.text).toContain("The price list changed.");
    expect(wakes(made)).toEqual([]);
  });

  it("applies the proposed value on a yes, logged as the Bot's, and wakes the Bot", async () => {
    const made = await proposed();

    const applied = await made.rpc.representative.factProposalApprove({ id: made.proposal.id });

    expect(applied).toMatchObject({ key: price.key, value: "50 USD" });
    expect(await valueOf(made)).toBe("50 USD");
    const [entry] = await made.rpc.representative.factLog();
    expect(entry).toMatchObject({
      key: price.key,
      action: "edit",
      proposedBy: "Ada",
      old: { value: "45 USD" },
      new: { value: "50 USD" },
    });
    expect(await made.rpc.representative.factProposals()).toEqual([]);
    expect((await cardsOf(made))[0]!.control).toMatchObject({ answer: "approved" });
    await expect.poll(() => wakes(made), poll).toHaveLength(1);
    expect(wakes(made)[0]).toContain("approved");
    expect(wakes(made)[0]).toContain(price.key);
  });

  it("keeps the owner's own changes unattributed in the log", async () => {
    const made = await proposed();
    const [added] = await made.rpc.representative.factLog();

    expect(added).toMatchObject({ action: "add", proposedBy: null });
  });

  it("adds a fact whose key is new, which needs a type and a topic", async () => {
    const made = await instance([
      proposes({ key: "phone.main", value: "+1 415 555 0100" }),
      quiet(),
    ]);
    await made.send("Add our phone");
    expect(toolResults(made.botFake)).toContain("needs a `type`");
    expect(await cardsOf(made)).toEqual([]);

    made.script([
      proposes({ key: "phone.main", value: "+1 415 555 0100", type: "phone", topic: "Contact" }),
      quiet(),
    ]);
    await made.send("Add our phone");
    const [proposal] = await made.rpc.representative.factProposals();
    expect(proposal).toMatchObject({ current: null, proposed: { value: "+14155550100" } });

    await made.rpc.representative.factProposalApprove({ id: proposal!.id });
    expect((await made.rpc.representative.factLog())[0]).toMatchObject({
      action: "add",
      proposedBy: "Ada",
    });
    expect(await made.rpc.representative.factList()).toMatchObject([
      { key: "phone.main", value: "+14155550100", topic: "Contact" },
    ]);
  });

  it("changes nothing on a no, and wakes the Bot", async () => {
    const made = await proposed();

    await made.rpc.representative.factProposalDecline({ id: made.proposal.id });

    expect(await valueOf(made)).toBe("45 USD");
    expect(await made.rpc.representative.factLog()).toHaveLength(1);
    expect(await made.rpc.representative.factProposals()).toEqual([]);
    expect((await cardsOf(made))[0]!.control).toMatchObject({ answer: "declined" });
    await expect.poll(() => wakes(made), poll).toHaveLength(1);
    expect(wakes(made)[0]).toContain("declined");
  });

  it("can't change the fact once it has expired after 7 days", async () => {
    const made = await proposed();

    made.later(7 * dayMs - 60_000);
    expect(await made.rpc.representative.factProposals()).toHaveLength(1);
    made.later(120_000);
    expect(await made.rpc.representative.factProposals()).toEqual([]);

    await expect(
      made.rpc.representative.factProposalApprove({ id: made.proposal.id }),
    ).rejects.toThrow();
    expect(await valueOf(made)).toBe("45 USD");
    expect(await made.rpc.representative.factLog()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wakes(made)).toEqual([]);
    expect((await cardsOf(made))[0]!.control).not.toHaveProperty("answer");
  });

  it("can be proposed again once the last one has expired", async () => {
    const made = await proposed();
    made.later(8 * dayMs);

    made.script([proposes({ key: price.key, value: "55 USD" }), quiet()]);
    await made.send("Try again");

    expect(await made.rpc.representative.factProposals()).toMatchObject([
      { proposed: { value: "55 USD" } },
    ]);
  });

  it("is dropped by a Bot reset, which wakes no one and changes nothing", async () => {
    const made = await proposed();

    await made.rpc.bots.reset({ botId: made.botId, name: "Ada" });

    await expect.poll(() => made.rpc.representative.factProposals(), poll).toEqual([]);
    expect((await cardsOf(made))[0]!.control).toMatchObject({ answer: "dropped" });
    await expect(
      made.rpc.representative.factProposalApprove({ id: made.proposal.id }),
    ).rejects.toThrow();
    expect(await valueOf(made)).toBe("45 USD");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wakes(made)).toEqual([]);
  });

  it("can't be answered once the Bot is reset, even before the reset's job has run", async () => {
    const made = await proposed();
    await runners.at(-1)!.stop();

    await made.rpc.bots.reset({ botId: made.botId, name: "Ada" });

    for (const answer of [
      made.rpc.representative.factProposalApprove,
      made.rpc.representative.factProposalDecline,
    ]) {
      await expect(answer({ id: made.proposal.id })).rejects.toThrow();
    }
    expect(await valueOf(made)).toBe("45 USD");
    expect(await made.rpc.representative.factLog()).toHaveLength(1);
    expect(await made.rpc.representative.factProposals()).toEqual([]);
    expect((await cardsOf(made))[0]!.control).toMatchObject({ answer: "dropped" });
    expect(wakes(made)).toEqual([]);
  });

  it("goes with its Bot", async () => {
    const made = await proposed();

    await getTestDb().delete(bot).where(eq(bot.id, made.botId));

    expect(await made.rpc.representative.factProposals()).toEqual([]);
    expect(await valueOf(made)).toBe("45 USD");
  });

  it("shows the fact as it is now, and applies over the owner's later edit", async () => {
    const made = await proposed();
    const [fact] = await made.rpc.representative.factList();
    await made.rpc.representative.factEdit({
      id: fact!.id,
      type: "money",
      topic: "Prices",
      value: "47 USD",
      validFrom: null,
      validUntil: null,
    });

    expect((await made.rpc.representative.factProposals())[0]!.current!.value).toBe("47 USD");
    await made.rpc.representative.factProposalApprove({ id: made.proposal.id });
    expect(await valueOf(made)).toBe("50 USD");
  });

  it("is not another owner's to answer", async () => {
    const made = await proposed();
    const other = await instance([]);

    expect(await other.rpc.representative.factProposals()).toEqual([]);
    await expect(
      other.rpc.representative.factProposalApprove({ id: made.proposal.id }),
    ).rejects.toThrow();
    await expect(
      other.rpc.representative.factProposalDecline({ id: made.proposal.id }),
    ).rejects.toThrow();
    expect(await valueOf(made)).toBe("45 USD");
    expect(await made.rpc.representative.factProposals()).toHaveLength(1);
  });

  it("can be answered only once", async () => {
    const made = await proposed();
    await made.rpc.representative.factProposalDecline({ id: made.proposal.id });

    await expect(
      made.rpc.representative.factProposalApprove({ id: made.proposal.id }),
    ).rejects.toThrow();
    expect(await valueOf(made)).toBe("45 USD");
  });
});

describe("the proposal tool", () => {
  it("is a deferred tool when the feature is on, and absent when it is off", async () => {
    const on = await instance([quiet()]);
    await on.send("hello");
    expect(JSON.stringify(on.botFake.calls[0]!.messages[0])).toContain("propose_fact");
    expect(on.botFake.calls[0]!.tools?.map((tool) => tool.name)).not.toContain("propose_fact");

    const off = await instance([proposes({ key: price.key, value: "50 USD" }), quiet()], {
      features: [],
    });
    await off.send("Raise the price");
    expect(JSON.stringify(off.botFake.calls[0]!.messages[0])).not.toContain("propose_fact");
    expect(toolResults(off.botFake)).toContain("error");
    expect(await cardsOf(off)).toEqual([]);
  });

  it("refuses a value that doesn't fit the fact's type, and posts nothing", async () => {
    const made = await instance([proposes({ key: price.key, value: "cheap" }), quiet()]);
    await made.rpc.representative.factAdd(price);

    await made.send("Make it cheap");

    expect(toolResults(made.botFake)).toContain("Not a valid money value");
    expect(await made.rpc.representative.factProposals()).toEqual([]);
    expect(await cardsOf(made)).toEqual([]);
  });

  it("refuses a second proposal while one waits on the key, and one that changes nothing", async () => {
    const made = await proposed();

    made.script([proposes({ key: price.key, value: "60 USD" }), quiet()]);
    await made.send("Higher");
    expect(toolResults(made.botFake)).toContain("already waits");

    await made.rpc.representative.factProposalDecline({ id: made.proposal.id });
    made.script([proposes({ key: price.key, value: "45 USD" }), quiet()]);
    await made.send("The same");
    expect(toolResults(made.botFake)).toContain("changes nothing");
    expect(await made.rpc.representative.factProposals()).toEqual([]);
  });

  it("keeps the fields a change doesn't name, and takes valid dates", async () => {
    const made = await instance([
      proposes({
        key: price.key,
        value: "50 USD",
        validUntil: "2030-01-01",
      }),
      quiet(),
    ]);
    await made.rpc.representative.factAdd(price);

    await made.send("A seasonal price");

    expect(await made.rpc.representative.factProposals()).toMatchObject([
      {
        proposed: {
          type: "money",
          topic: "Prices",
          validFrom: null,
          validUntil: new Date("2030-01-01T00:00:00Z"),
        },
      },
    ]);
  });

  it('keeps a date the Model sends as null, as a strict tool schema makes it, and clears one only on "none"', async () => {
    const made = await instance([
      proposes({ key: price.key, value: "50 USD", validFrom: null, validUntil: null }),
      quiet(),
    ]);
    await made.rpc.representative.factAdd({
      ...price,
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2030-01-01T00:00:00Z"),
    });

    await made.send("A new price");

    const [kept] = await made.rpc.representative.factProposals();
    expect(kept!.proposed).toMatchObject({
      value: "50 USD",
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: new Date("2030-01-01T00:00:00Z"),
    });

    await made.rpc.representative.factProposalDecline({ id: kept!.id });
    made.script([
      proposes({ key: price.key, value: "50 USD", validFrom: null, validUntil: "none" }),
      quiet(),
    ]);
    await made.send("All year round now");

    const [cleared] = await made.rpc.representative.factProposals();
    expect(cleared!.proposed).toMatchObject({
      validFrom: new Date("2020-01-01T00:00:00Z"),
      validUntil: null,
    });
  });

  it("gives the same answer when a replay runs a call that already proposed", async () => {
    const made = await proposed();
    const asked = (made.botFake.calls.at(-1)?.messages ?? []).find(
      (message) => message.role === "assistant" && message.toolCalls?.length,
    );
    const toolCallId = asked!.toolCalls![0]!.id;
    const { context } = made.deps.parts.features[0]!;
    const [taken] = await getTestDb()
      .select({ id: botTurn.id })
      .from(botTurn)
      .where(eq(botTurn.botId, made.botId));
    const turn = { id: taken!.id, botId: made.botId, userId: made.user.id };
    const [tool] = factProposalTools(turn as never, context as never);
    const input = { key: price.key, value: "50 USD", why: "The price list changed." };

    expect(await tool!.execute!(input, { toolCallId } as never)).toHaveProperty("saved");
    expect(await cardsOf(made)).toHaveLength(1);

    // Another call of the Bot's, not a replay, is refused.
    expect(await tool!.execute!(input, { toolCallId: "another" } as never)).toMatchObject({
      error: expect.stringContaining("already waits"),
    });
  });
  it.each(["approved", "declined"] as const)(
    "gives the same answer when a replay runs a call whose card the owner %s",
    async (answer) => {
      const made = await proposed();
      const asked = (made.botFake.calls.at(-1)?.messages ?? []).find(
        (message) => message.role === "assistant" && message.toolCalls?.length,
      );
      const toolCallId = asked!.toolCalls![0]!.id;
      const { context } = made.deps.parts.features[0]!;
      const [taken] = await getTestDb()
        .select({ id: botTurn.id })
        .from(botTurn)
        .where(eq(botTurn.botId, made.botId));
      const turn = { id: taken!.id, botId: made.botId, userId: made.user.id };
      const [tool] = factProposalTools(turn as never, context as never);
      const input = { key: price.key, value: "50 USD", why: "The price list changed." };
      await (answer === "approved"
        ? made.rpc.representative.factProposalApprove({ id: made.proposal.id })
        : made.rpc.representative.factProposalDecline({ id: made.proposal.id }));

      expect(await tool!.execute!(input, { toolCallId } as never)).toHaveProperty("saved");

      expect(await cardsOf(made)).toHaveLength(1);
      expect(await made.rpc.representative.factProposals()).toEqual([]);
    },
  );
});
