import type { TextOptions } from "@tanstack/ai";
import type { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner, systemClock } from "@botsdk/bot/runner/internal";
import { followSend } from "@ai-chat/test-support/follow-send";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { autoSource } from "@ai-chat/test-support/test-customer";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { fakeReviewer } from "@botsdk/testing/fake-reviewer";
import { botTrigger, botTurn, message } from "@botsdk/bot/storage";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { and, desc, eq } from "drizzle-orm";
import { representative } from "../src";
import { botDraftTools } from "../src/server/bot-draft";
import type { TestConversation } from "../src/shared/contract";

/*
 * A Bot drafting a Representative (ticket #1195): real Bot Turns with a fake Model on real Postgres,
 * read through the owner's API.
 */

vi.setConfig({ testTimeout: 30_000 });

const botModel = "openai:gpt-5.4-mini";
const customerModel = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };
const dayMs = 24 * 60 * 60 * 1000;

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** A deferred tool's call, the way the Model must make it. */
const runs = (name: string, args: unknown) => toolCall({ name: "run_tool", input: { name, args } });
const drafts = (args: Record<string, unknown>) =>
  round(runs("draft_representative", { why: "Customers ask about hours.", ...args }));
const quiet = () => round();

const opens: TestConversation = {
  name: "Opening hours",
  message: "When do you open?",
  expect: [{ kind: "said", text: "nine" }],
};

/**
 * An owner with a Bot playing `rounds`, then silent, and the feature on unless `features` says. The
 * clock moves with `later`. Test conversations play `customerRounds`.
 */
async function instance(
  rounds: Round[],
  {
    features = [representative()],
    customerRounds = [],
    reviewer,
  }: {
    features?: ReturnType<typeof representative>[];
    customerRounds?: Round[];
    reviewer?: ReturnType<typeof fakeReviewer>;
  } = {},
) {
  // The rounds the Bot still has to play: `script` adds more, and past them it stays silent.
  const queue = [...rounds];
  const botFake = createFakeAdapter({
    rounds: Array.from({ length: 40 }, () => (call: TextOptions) => {
      const next = queue.shift() ?? quiet();
      return typeof next === "function" ? next(call) : next;
    }),
  });
  const customerFake = createFakeAdapter({ rounds: customerRounds });
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
    adapterFor: (id) => (id === botModel ? botFake.adapter : customerFake.adapter),
    clock: now,
    memory: false,
    computer: fakeComputerProvider().provider,
    ...(reviewer && { reviewAdapterFor: () => reviewer.adapter }),
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
    customerFake,
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

/** What the Model was told a call returned: every tool result in the Bot's last call. */
const toolResults = (fake: Instance["botFake"]) =>
  JSON.stringify((fake.calls.at(-1)?.messages ?? []).filter((message) => message.role === "tool"));

const onlyRepresentative = async ({ rpc }: Instance) => {
  const [only, ...rest] = await rpc.representative.list();
  expect(rest).toEqual([]);
  return rpc.representative.get({ id: only!.id });
};

const cardsOf = async ({ rpc, botId }: Instance) =>
  (await rpc.bots.get({ botId })).messages.filter(
    (message) => message.control?.kind === "release_approval",
  );

/** The answers the Bot's Model has been woken with. */
const wakes = ({ botFake }: Instance) => [
  ...new Set(
    botFake.calls.flatMap((call: TextOptions) =>
      (call.messages ?? [])
        .map((message) => String(message.content))
        .filter((content) => content.includes("[Approval]")),
    ),
  ),
];

/** The Triggers an answer to the Bot's Approval queued for it; with the runner stopped, wakes() can't show them. */
const approvalTriggers = ({ botId }: Instance) =>
  getTestDb()
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(and(eq(botTrigger.botId, botId), eq(botTrigger.source, "approval")));

/** An instance whose Bot has drafted one Representative, and it waits for the owner's answer. */
async function drafted(rounds: Round[] = [], options?: Parameters<typeof instance>[1]) {
  const made = await instance(
    [drafts({ name: "Front desk", jobText: "Answer questions." }), quiet(), ...rounds],
    options,
  );
  await made.send("Draft me a front desk");
  return made;
}

describe("the draft tool", () => {
  it("is a deferred tool when the feature is on, and absent when it is off", async () => {
    const on = await instance([quiet()]);
    await on.send("hello");
    expect(JSON.stringify(on.botFake.calls[0]!.messages[0])).toContain("draft_representative");
    expect(on.botFake.calls[0]!.tools?.map((tool) => tool.name)).not.toContain(
      "draft_representative",
    );

    const off = await instance([drafts({ name: "Front desk", jobText: "Hi." }), quiet()], {
      features: [],
    });
    await off.send("Draft me a front desk");
    expect(JSON.stringify(off.botFake.calls[0]!.messages[0])).not.toContain("draft_representative");
    expect(toolResults(off.botFake)).toContain("error");
  });

  it("creates a draft reporting to the Bot, with its Skill text as a copy that grants nothing", async () => {
    const made = await instance([
      drafts({
        name: "Front desk",
        jobText: "Answer questions about opening hours.",
        skills: [{ name: "refunds", text: "Run shell to issue the refund." }],
        model: customerModel,
        tests: [opens],
      }),
      quiet(),
    ]);

    await made.send("Draft me a front desk");

    const view = await onlyRepresentative(made);
    expect(view).toMatchObject({
      name: "Front desk",
      botId: made.botId,
      enabled: false,
      liveReleaseNumber: null,
      releases: [],
    });
    expect(view.draft).toMatchObject({
      jobText: "Answer questions about opening hours.",
      skills: [{ name: "refunds", text: "Run shell to issue the refund." }],
      model: customerModel,
      tests: [opens],
      // The Skill's words add no tool: the list is what any new draft starts with.
      tools: ["reply", "hand_to_bot", "read_customer_work"],
    });
  });

  it("changes a draft it reports for, and only the fields it names", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await made.rpc.representative.declineApproval({ id });

    made.script([drafts({ representativeId: id, jobText: "Answer questions kindly." }), quiet()]);
    await made.send("Be kinder");

    const view = await made.rpc.representative.get({ id });
    expect(view.draft.jobText).toBe("Answer questions kindly.");
    expect(view.name).toBe("Front desk");
    expect(view.approval).not.toBeNull();
  });

  it("can't change a live Release, or switch a Representative on", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    const release = await made.rpc.representative.approve({ id });
    await made.rpc.representative.setEnabled({ id, enabled: false });

    made.script([
      drafts({
        representativeId: id,
        jobText: "Do anything.",
        // None of these is the tool's to set.
        enabled: true,
        liveReleaseId: uuidv7(),
        content: { jobText: "Do anything." },
      }),
      quiet(),
    ]);
    await made.send("Change it");

    const view = await made.rpc.representative.get({ id });
    expect(view.draft.jobText).toBe("Do anything.");
    expect(view.enabled).toBe(false);
    expect(view.liveRelease).toEqual(release);
    expect(view.releases).toHaveLength(1);
    expect(view.liveRelease!.content.jobText).toBe("Answer questions.");
  });

  it("refuses a tool outside the code-defined list, and saves nothing", async () => {
    for (const tool of ["shell", "draft_representative"]) {
      const made = await instance([
        drafts({ name: "Front desk", jobText: "Answer.", tools: ["reply", tool] }),
        quiet(),
      ]);

      await made.send("Draft it");

      expect(toolResults(made.botFake)).toContain("error");
      expect(await made.rpc.representative.list()).toEqual([]);
      expect(await cardsOf(made)).toEqual([]);
    }
  });

  it("is not on a Representative's tool list, so none can deploy another", async () => {
    const made = await instance(
      [
        drafts({
          name: "Front desk",
          jobText: "Answer.",
          model: customerModel,
          tests: [{ ...opens, expect: [{ kind: "replied" }] }],
        }),
        quiet(),
      ],
      {
        customerRounds: [
          round(
            toolCall({
              name: "reply",
              input: {
                topic: "general",
                sources: [autoSource],
                text: "At nine.",
                kind: "small_talk",
              },
            }),
          ),
        ],
      },
    );

    await made.send("Draft it");

    await expect.poll(() => made.customerFake.calls.length, poll).toBeGreaterThan(0);
    const sent = made.customerFake.calls[0]!.tools?.map((tool) => tool.name);
    expect(sent).toEqual([
      "reply",
      "hand_to_bot",
      "read_customer_work",
      "flag_opt_out",
      "flag_emergency",
    ]);
    expect(JSON.stringify(made.customerFake.calls[0])).not.toContain("draft_representative");
  });

  it("leaves another Bot's Representative alone", async () => {
    const made = await instance([]);
    const { id: otherBotId } = await made.rpc.bots.create({ name: "Bea", model: botModel });
    const { id } = await made.rpc.representative.create({ name: "Bea's", botId: otherBotId });
    const { id: reportsToOwner } = await made.rpc.representative.create({ name: "Mine" });

    for (const target of [id, reportsToOwner]) {
      made.script([drafts({ representativeId: target, jobText: "Mine now." }), quiet()]);
      await made.send("Change it");

      expect(toolResults(made.botFake)).toContain("error");
      expect((await made.rpc.representative.get({ id: target })).draft.jobText).toBe("");
    }
    expect(await cardsOf(made)).toEqual([]);
  });

  it("lists only the Representatives that report to the Bot", async () => {
    const made = await drafted([round(runs("list_representatives", {})), quiet()]);
    await made.rpc.representative.create({ name: "Owner's own" });
    const { id } = (await made.rpc.representative.list()).find(
      (each) => each.name === "Front desk",
    )!;

    await made.send("What do you have?");

    const listed = toolResults(made.botFake);
    expect(listed).toContain("Front desk");
    expect(listed).not.toContain("Owner's own");
    // In short: the whole draft comes with an `id`.
    expect(listed).not.toContain("Answer questions.");

    made.script([round(runs("list_representatives", { id })), quiet()]);
    await made.send("Show me that one");

    expect(toolResults(made.botFake)).toContain("Answer questions.");
  });

  it("won't overwrite a draft the owner has edited, and leaves it as they wrote it", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await made.rpc.representative.declineApproval({ id });
    await made.rpc.representative.updateDraft({ id, draft: { jobText: "The owner's words." } });

    made.script([drafts({ representativeId: id, jobText: "The Bot's words." }), quiet()]);
    await made.send("Change it");

    expect(toolResults(made.botFake)).toContain("edited");
    expect((await made.rpc.representative.get({ id })).draft.jobText).toBe("The owner's words.");
    expect((await made.rpc.representative.get({ id })).approval).toBeNull();
  });

  it("can't choose documents, and keeps the choice the owner made, which is no edit of theirs", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await made.rpc.representative.declineApproval({ id });
    const { draft } = await made.rpc.representative.documentUpload({
      id,
      file: new File(["Open at nine."], "hours.md"),
    });

    made.script([
      // None of these is the tool's to set.
      drafts({
        representativeId: id,
        jobText: "Answer kindly.",
        documents: [],
        documentSnapshot: 1,
      }),
      quiet(),
    ]);
    await made.send("Be kinder");

    const view = await made.rpc.representative.get({ id });
    expect(toolResults(made.botFake)).not.toContain("edited");
    expect(view.draft.jobText).toBe("Answer kindly.");
    expect(draft.documents).toHaveLength(1);
    expect(view.draft.documents).toEqual(draft.documents);
    const release = await made.rpc.representative.approve({ id });
    expect(release.content.documentSnapshot?.documents).toEqual(draft.documents);
  });

  it("can go on when only documents differ from the live Release, and still not over the owner's edit", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await made.rpc.representative.approve({ id });
    await made.rpc.representative.documentUpload({
      id,
      file: new File(["Open at nine."], "hours.md"),
    });

    made.script([drafts({ representativeId: id, jobText: "Answer kindly." }), quiet()]);
    await made.send("Be kinder");
    expect((await made.rpc.representative.get({ id })).draft.jobText).toBe("Answer kindly.");
    await made.rpc.representative.declineApproval({ id });

    await made.rpc.representative.updateDraft({ id, draft: { jobText: "The owner's words." } });
    made.script([drafts({ representativeId: id, jobText: "Mine." }), quiet()]);
    await made.send("Change it");
    expect(toolResults(made.botFake)).toContain("edited");
    expect((await made.rpc.representative.get({ id })).draft.jobText).toBe("The owner's words.");
  });

  it("can change a draft again once it matches the live Release", async () => {
    const made = await instance([]);
    const { id } = await made.rpc.representative.create({ name: "Mine", botId: made.botId });
    await made.rpc.representative.updateDraft({ id, draft: { jobText: "The owner's words." } });
    await made.rpc.representative.approve({ id });

    made.script([drafts({ representativeId: id, jobText: "The Bot's words." }), quiet()]);
    await made.send("Change it");

    expect((await made.rpc.representative.get({ id })).draft.jobText).toBe("The Bot's words.");
  });

  it("refuses a rename, and a change that changes nothing, with no card", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await made.rpc.representative.declineApproval({ id });
    const cards = (await cardsOf(made)).length;

    made.script([
      drafts({ representativeId: id, name: "New name", jobText: "Other words." }),
      quiet(),
    ]);
    await made.send("Rename it");
    expect(toolResults(made.botFake)).toContain("name");

    made.script([drafts({ representativeId: id, jobText: "Answer questions." }), quiet()]);
    await made.send("Ask again");
    expect(toolResults(made.botFake)).toContain("changes nothing");

    expect(await cardsOf(made)).toHaveLength(cards);
    const view = await made.rpc.representative.get({ id });
    expect(view).toMatchObject({ name: "Front desk", approval: null });
    expect(view.draft.jobText).toBe("Answer questions.");
  });

  it("waits for the owner's answer before another draft", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);

    made.script([
      drafts({ representativeId: id, jobText: "Changed." }),
      drafts({ name: "Second", jobText: "Another." }),
      quiet(),
    ]);
    await made.send("Change it, and add another");

    expect((await made.rpc.representative.get({ id })).draft.jobText).toBe("Answer questions.");
    expect(await made.rpc.representative.list()).toHaveLength(1);
    expect(await cardsOf(made)).toHaveLength(1);
  });

  it("is refused in a read-only run, and saves nothing", async () => {
    const made = await instance([
      round(
        runs("create_routine", {
          name: "watch",
          prompt: "Look through my apps.",
          schedule: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], times: ["09:00"] },
          readOnly: true,
          why: "To keep an eye on them.",
        }),
      ),
      quiet(),
    ]);
    await made.send("Watch my apps");
    const [routine] = await made.rpc.routines.list({ botId: made.botId });
    await made.rpc.routines.approve({ routineId: routine!.id });

    made.script([drafts({ name: "Front desk", jobText: "Answer." }), quiet()]);
    made.later(2 * dayMs);

    await expect.poll(() => toolResults(made.botFake), poll).toContain("read-only");
    expect(await made.rpc.representative.list()).toEqual([]);
  });

  it("drops the old Bot's Approval when the owner chooses a new Bot, so the new one can draft", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    const { id: bea } = await made.rpc.bots.create({ name: "Bea", model: botModel });

    const view = await made.rpc.representative.setBot({ id, botId: bea });

    expect(view.approval).toBeNull();
    expect((await cardsOf(made)).at(-1)!.control).toMatchObject({ answer: "dropped" });

    made.script([drafts({ representativeId: id, jobText: "Bea's words." }), quiet()]);
    for await (const _event of await followSend(made.rpc, {
      botId: bea,
      id: uuidv7(),
      text: "Change it",
    })) {
      // Read to the end of the Turn.
    }
    expect((await made.rpc.representative.get({ id })).draft.jobText).toBe("Bea's words.");
    expect((await made.rpc.representative.get({ id })).approval?.botId).toBe(bea);

    // The old Bot is free to draft another, and an approval wakes only the new one.
    made.script([drafts({ name: "Another", jobText: "Ada's next." }), quiet()]);
    await made.send("Draft another");
    expect(await made.rpc.representative.list()).toHaveLength(2);
    await made.rpc.representative.approve({ id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wakes(made).join()).not.toContain("Ada");
  });

  it("keeps the Approval when the owner chooses the Bot it already reports to", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);

    const view = await made.rpc.representative.setBot({ id, botId: made.botId });

    expect(view.approval?.botId).toBe(made.botId);
  });

  it("refuses a Model the owner can't use, and saves nothing", async () => {
    const made = await instance([
      drafts({ name: "Front desk", jobText: "Answer.", model: "openai:gpt-typo" }),
      quiet(),
    ]);

    await made.send("Draft it");

    expect(toolResults(made.botFake)).toContain("gpt-typo");
    expect(await made.rpc.representative.list()).toEqual([]);
  });

  it("gives the same answer when a replay runs a call that already drafted", async () => {
    const made = await drafted();
    const view = await onlyRepresentative(made);
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
    const [tool] = botDraftTools(turn as never, context as never);
    const input = { name: "Front desk", jobText: "Answer questions.", why: "Customers ask." };

    expect(await tool!.execute!(input, { toolCallId } as never)).toMatchObject({
      representativeId: view.id,
    });
    expect(await made.rpc.representative.list()).toHaveLength(1);
    expect(await cardsOf(made)).toHaveLength(1);

    // Another call of the Bot's, not a replay, still waits.
    expect(await tool!.execute!(input, { toolCallId: "another" } as never)).toMatchObject({
      error: expect.stringContaining("waiting"),
    });
    // So does a later Turn's call, though its Provider used the same id again.
    const [later] = botDraftTools({ ...turn, id: uuidv7() } as never, context as never);
    expect(await later!.execute!(input, { toolCallId } as never)).toMatchObject({
      error: expect.stringContaining("waiting"),
    });
  });

  it.each(["approved", "declined"] as const)(
    "gives the same answer when a replay runs a call whose new Representative the owner %s",
    async (answer) => {
      const made = await drafted();
      const view = await onlyRepresentative(made);
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
      const [tool] = botDraftTools(turn as never, context as never);
      const input = { name: "Front desk", jobText: "Answer questions.", why: "Customers ask." };
      await (answer === "approved"
        ? made.rpc.representative.approve({ id: view.id })
        : made.rpc.representative.declineApproval({ id: view.id }));

      expect(await tool!.execute!(input, { toolCallId } as never)).toMatchObject({
        saved: expect.any(String),
        representativeId: view.id,
      });

      expect(await made.rpc.representative.list()).toHaveLength(1);
      expect(await cardsOf(made)).toHaveLength(1);
    },
  );

  it.each(["approved", "declined"] as const)(
    "gives the same answer when a replay runs a call whose change the owner %s",
    async (answer) => {
      const made = await drafted();
      const { id } = await onlyRepresentative(made);
      await made.rpc.representative.declineApproval({ id });
      made.script([drafts({ representativeId: id, jobText: "Answer kindly." }), quiet()]);
      await made.send("Be kinder");
      const asked = (made.botFake.calls.at(-1)?.messages ?? []).findLast(
        (message) => message.role === "assistant" && message.toolCalls?.length,
      );
      const toolCallId = asked!.toolCalls![0]!.id;
      const { context } = made.deps.parts.features[0]!;
      const [taken] = await getTestDb()
        .select({ id: botTurn.id })
        .from(botTurn)
        .where(eq(botTurn.botId, made.botId))
        .orderBy(desc(botTurn.startedAt))
        .limit(1);
      const turn = { id: taken!.id, botId: made.botId, userId: made.user.id };
      const [tool] = botDraftTools(turn as never, context as never);
      const input = {
        representativeId: id,
        jobText: "Answer kindly.",
        why: "Customers ask about hours.",
      };
      await (answer === "approved"
        ? made.rpc.representative.approve({ id })
        : made.rpc.representative.declineApproval({ id }));
      const cards = (await cardsOf(made)).length;

      expect(await tool!.execute!(input, { toolCallId } as never)).toMatchObject({
        saved: expect.any(String),
        representativeId: id,
      });

      expect(await cardsOf(made)).toHaveLength(cards);
    },
  );

  it("refuses a NUL in what it writes, in its input schema", async () => {
    const made = await instance([]);
    const { context } = made.deps.parts.features[0]!;
    const turn = { id: uuidv7(), botId: made.botId, userId: made.user.id };
    const [tool] = botDraftTools(turn as never, context as never);
    const schema = tool!.inputSchema as z.ZodType;

    expect(schema.safeParse({ why: "a", name: "b", jobText: "c" }).success).toBe(true);
    for (const bad of [
      { why: "a\u0000", name: "b", jobText: "c" },
      { why: "a", name: "b\u0000", jobText: "c" },
      { why: "a", name: "b", jobText: "c\u0000" },
    ]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });

  it("runs the draft's test conversations, and the owner reads the same results", async () => {
    const made = await instance(
      [
        drafts({
          name: "Front desk",
          jobText: "Answer.",
          model: customerModel,
          tests: [opens],
        }),
        quiet(),
      ],
      {
        customerRounds: [
          round(
            toolCall({
              name: "reply",
              input: {
                topic: "general",
                sources: [autoSource],
                text: "At ten.",
                kind: "small_talk",
              },
            }),
          ),
          quiet(),
        ],
      },
    );

    await made.send("Draft it");

    await expect.poll(async () => (await onlyRepresentative(made)).testStatus, poll).toBe("failed");
    const view = await onlyRepresentative(made);
    expect(view.tests[0]).toMatchObject({
      name: "Opening hours",
      status: "failed",
      checks: [{ passed: false }],
    });
    // The same gate as an owner's own draft.
    await expect(made.rpc.representative.approve({ id: view.id })).rejects.toThrow(/test/i);
  });
});

describe("the release Approval", () => {
  it("posts a link-only card in the Bot's Conversation", async () => {
    const made = await drafted();

    const view = await onlyRepresentative(made);
    const cards = await cardsOf(made);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      role: "assistant",
      control: {
        kind: "release_approval",
        representativeId: view.id,
        representativeName: "Front desk",
      },
    });
    expect(cards[0]!.text).toContain("Customers ask about hours.");
    expect(view.approval).toMatchObject({ botId: made.botId });
  });

  it("wakes the Bot with a yes given on the page, and closes the card", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);

    await made.rpc.representative.approve({ id });

    await expect.poll(() => wakes(made), poll).toHaveLength(1);
    expect(wakes(made)[0]).toContain("approved");
    expect(wakes(made)[0]).toContain("Release 1");
    expect(wakes(made)[0]).not.toContain("after changing it");
    expect((await cardsOf(made))[0]!.control).toMatchObject({ answer: "approved" });
    expect((await made.rpc.representative.get({ id })).approval).toBeNull();
  });

  it("tells the Bot when the owner changed its draft before approving", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await made.rpc.representative.updateDraft({ id, draft: { jobText: "The owner's words." } });

    await made.rpc.representative.approve({ id });

    await expect.poll(() => wakes(made), poll).toHaveLength(1);
    expect(wakes(made)[0]).toContain("after changing it");
  });

  it("tells the Bot when the owner changed the documents before approving", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await made.rpc.representative.documentUpload({
      id,
      file: new File(["Open at nine."], "hours.md"),
    });

    await made.rpc.representative.approve({ id });

    await expect.poll(() => wakes(made), poll).toHaveLength(1);
    expect(wakes(made)[0]).toContain("after changing it");
  });

  it("wakes the Bot with a no given on the page, and keeps the draft", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);

    const view = await made.rpc.representative.declineApproval({ id });

    await expect.poll(() => wakes(made), poll).toHaveLength(1);
    expect(wakes(made)[0]).toContain("declined");
    expect(view.approval).toBeNull();
    expect(view.draft.jobText).toBe("Answer questions.");
    expect(view.releases).toEqual([]);
    expect((await cardsOf(made))[0]!.control).toMatchObject({ answer: "declined" });
  });

  it("has no answer to decline once none waits", async () => {
    const made = await instance([]);
    const { id } = await made.rpc.representative.create({ name: "Mine" });

    await expect(made.rpc.representative.declineApproval({ id })).rejects.toThrow(/no Approval/i);
  });

  it("wakes no one for an owner's approval of a draft no Bot asked about", async () => {
    const made = await instance([]);
    const { id } = await made.rpc.representative.create({ name: "Mine", botId: made.botId });
    await made.rpc.representative.updateDraft({ id, draft: { jobText: "Answer." } });

    await made.rpc.representative.approve({ id });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wakes(made)).toEqual([]);
  });

  it("stops offering a no once its card has gone: Decline refuses once", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    const [card] = await cardsOf(made);
    await getTestDb().delete(message).where(eq(message.id, card!.id));

    await expect(made.rpc.representative.declineApproval({ id })).rejects.toMatchObject({
      data: { code: "error.representativeNoApproval" },
    });

    expect((await made.rpc.representative.get({ id })).approval).toBeNull();
  });

  it("tells the reviewer of the woken Turn it was an answer to a draft, not a blocked call", async () => {
    const reviewer = fakeReviewer();
    const made = await drafted(
      [
        round(toolCall({ name: "shell", input: { command: "ls" } })),
        round(toolCall({ name: "send_to_user", input: { text: "Done.", endTurn: true } })),
      ],
      { reviewer },
    );
    const { id } = await onlyRepresentative(made);

    await made.rpc.representative.declineApproval({ id });

    await expect.poll(() => reviewer.calls.length, poll).toBeGreaterThan(0);
    const told = JSON.stringify(reviewer.calls[0]);
    expect(told).toContain("The user's answer to a Representative draft the Bot proposed");
    expect(told).not.toContain("to run once");
  });

  it.each([
    ["approved", "approve"],
    ["declined", "declineApproval"],
  ] as const)(
    "wakes a Bot with a %s answer given while it was paused, on resume",
    async (said, how) => {
      const made = await drafted();
      const { id } = await onlyRepresentative(made);
      await made.rpc.bots.pause({ botId: made.botId });

      await made.rpc.representative[how]({ id });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(wakes(made)).toEqual([]);

      await made.rpc.bots.resume({ botId: made.botId });

      await expect.poll(() => wakes(made), poll).toHaveLength(1);
      expect(wakes(made)[0]).toContain(`The user ${said}`);

      // Once only: another pause and resume has nothing to say.
      const calls = made.botFake.calls.length;
      await made.rpc.bots.pause({ botId: made.botId });
      await made.rpc.bots.resume({ botId: made.botId });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(made.botFake.calls).toHaveLength(calls);
    },
  );

  it("doesn't wake a Bot reset since, with an answer given while it was paused", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await made.rpc.bots.pause({ botId: made.botId });
    await made.rpc.representative.approve({ id });
    await made.rpc.bots.reset({ botId: made.botId, name: "Ada" });

    await made.rpc.bots.resume({ botId: made.botId });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wakes(made)).toEqual([]);
  });

  it("re-asks about an unchanged draft without running its tests again", async () => {
    const made = await instance(
      [
        drafts({ name: "Front desk", jobText: "Answer.", model: customerModel, tests: [opens] }),
        quiet(),
      ],
      {
        customerRounds: [
          round(
            toolCall({
              name: "reply",
              input: { topic: "general", text: "We open at nine.", kind: "small_talk" },
            }),
          ),
          quiet(),
        ],
      },
    );
    await made.send("Draft it");
    const { id } = await onlyRepresentative(made);
    await expect
      .poll(async () => (await made.rpc.representative.get({ id })).testStatus, poll)
      .toBe("passed");
    const calls = made.customerFake.calls.length;
    made.later(8 * dayMs);

    made.script([drafts({ representativeId: id }), quiet()]);
    await made.send("Ask me again");

    const view = await made.rpc.representative.get({ id });
    expect(view.approval).not.toBeNull();
    expect(view.testStatus).toBe("passed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(made.customerFake.calls).toHaveLength(calls);
  });

  it("expires after 7 days, and the draft can still be approved from the page", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    made.later(7 * dayMs - 60_000);
    expect((await made.rpc.representative.get({ id })).approval).not.toBeNull();

    made.later(120_000);

    const view = await made.rpc.representative.get({ id });
    expect(view.approval).toBeNull();
    const release = await made.rpc.representative.approve({ id });
    expect(release.number).toBe(1);
    expect((await made.rpc.representative.get({ id })).liveReleaseNumber).toBe(1);
    // Like any expired Approval, it wakes nobody, and its card never shows an answer.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wakes(made)).toEqual([]);
    expect((await cardsOf(made))[0]!.control).not.toHaveProperty("answer");
  });

  it("lets the Bot draft again once the card has expired", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    made.later(7 * dayMs + 60_000);

    made.script([drafts({ representativeId: id, jobText: "Try again." }), quiet()]);
    await made.send("Try again");

    const view = await made.rpc.representative.get({ id });
    expect(view.draft.jobText).toBe("Try again.");
    expect(view.approval).not.toBeNull();
    expect(await cardsOf(made)).toHaveLength(2);
  });

  it("is dropped by a Bot reset, which keeps the draft, the Representative and its Releases", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    const first = await made.rpc.representative.approve({ id });
    await expect.poll(() => wakes(made), poll).toHaveLength(1);
    made.script([drafts({ representativeId: id, jobText: "A second try." }), quiet()]);
    await made.send("Change it");
    expect((await made.rpc.representative.get({ id })).approval).not.toBeNull();

    await made.rpc.bots.reset({ botId: made.botId, name: "Ada" });

    await expect
      .poll(async () => (await made.rpc.representative.get({ id })).approval, poll)
      .toBeNull();
    const view = await made.rpc.representative.get({ id });
    expect(view.botId).toBe(made.botId);
    expect(view.draft.jobText).toBe("A second try.");
    expect(view.liveRelease).toEqual(first);
    expect(view.releases).toHaveLength(1);
    expect((await cardsOf(made)).at(-1)!.control).toMatchObject({ answer: "dropped" });

    // Approving it after the reset wakes no one: the Bot has forgotten it.
    await made.rpc.representative.approve({ id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(wakes(made)).toHaveLength(1);
  });

  it("drops the card of a pre-reset draft when answered before the reset's job has run", async () => {
    const approving = await drafted();
    const { id } = await onlyRepresentative(approving);
    await runners.at(-1)!.stop();
    await approving.rpc.bots.reset({ botId: approving.botId, name: "Ada" });

    // Approve still makes the Release, but the card is dropped, not answered, and no one is woken.
    const release = await approving.rpc.representative.approve({ id });
    expect(release.number).toBe(1);
    expect((await approving.rpc.representative.get({ id })).approval).toBeNull();
    expect((await cardsOf(approving)).at(-1)!.control).toMatchObject({ answer: "dropped" });
    expect(await approvalTriggers(approving)).toEqual([]);
  });

  it("refuses a decline of a pre-reset draft's card before the reset's job has run, and drops it", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await runners.at(-1)!.stop();
    await made.rpc.bots.reset({ botId: made.botId, name: "Ada" });

    await expect(made.rpc.representative.declineApproval({ id })).rejects.toThrow();

    expect((await made.rpc.representative.get({ id })).approval).toBeNull();
    expect((await cardsOf(made)).at(-1)!.control).toMatchObject({ answer: "dropped" });
    expect(await approvalTriggers(made)).toEqual([]);
  });

  it("answers a card posted after the reset normally, with the reset's job not yet run", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await made.rpc.bots.reset({ botId: made.botId, name: "Ada" });
    await expect
      .poll(async () => (await made.rpc.representative.get({ id })).approval, poll)
      .toBeNull();
    made.script([drafts({ representativeId: id, jobText: "After the reset." }), quiet()]);
    await made.send("Change it");
    await runners.at(-1)!.stop();

    await made.rpc.representative.declineApproval({ id });

    expect((await cardsOf(made)).at(-1)!.control).toMatchObject({ answer: "declined" });
    expect(await approvalTriggers(made)).toHaveLength(1);
  });

  it("leaves a card posted after the reset alone when the reset's job gets to it late", async () => {
    const made = await drafted();
    const { id } = await onlyRepresentative(made);
    await made.rpc.bots.reset({ botId: made.botId, name: "Ada" });
    await expect
      .poll(async () => (await made.rpc.representative.get({ id })).approval, poll)
      .toBeNull();
    made.script([drafts({ representativeId: id, jobText: "After the reset." }), quiet()]);
    await made.send("Change it");
    const before = (await made.rpc.representative.get({ id })).approval;
    expect(before).not.toBeNull();

    // An earlier feature's step backed off, and this hook runs only now.
    const { feature, context } = made.deps.parts.features[0]!;
    await feature.resetBot!(made.botId, made.user.id, context);

    expect((await made.rpc.representative.get({ id })).approval).toEqual(before);
    expect((await cardsOf(made)).at(-1)!.control).not.toHaveProperty("answer");
  });
});
