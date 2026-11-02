import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { conversationChannel } from "../../src/chat/conversation-events";
import { bot, botAssignment, botTrigger, botTurn, usage } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { deleteUserData, exportUserData } from "../../src/user-data";
import { assignmentTools, turnBudget, wakeOnAssignments } from "../../src/bot/assignments";
import { assignWork } from "../../src/bot/assignments/assignment";
import type { Transaction } from "../../src/plugin";
import { receive } from "../../src/bot/triggers";
import { saveCredentials } from "../../src/models/internal";
import {
  inProcessRunner,
  type JobRunner,
  loadHistory,
  type WorkflowContext,
} from "../../src/runner/internal";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { botContract } from "@botsdk/client/bot/contract";
import { taskCount } from "@botsdk/client/bot/tasks";
import {
  createFakeAdapter,
  type FakeAdapter,
  round,
  toolCall,
  withUsage,
} from "@botsdk/testing/fake-adapter";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { fakeReviewer, type FakeReviewer } from "@botsdk/testing/fake-reviewer";

/*
 * Assignments (spec #1166, ticket #1181): real Bot Turns with the fake Model on real Postgres, read
 * through the owner API. A Bot hands work to another with no Room, the assigned Bot works on it over
 * as many Turns as it needs and finishes it with a tool call, and the assigning Bot wakes with the
 * result.
 */

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const planModel = "openai:gpt-6.1-sol";
const hostModel = "anthropic:claude-sonnet-5-5";
const hostProviders = [
  {
    provider: "anthropic" as const,
    credentials: { apiKey: "sk-host-secret-never-stored" },
    models: [
      {
        modelId: "claude-sonnet-5-5",
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
];
const timeout = 30_000;
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: JobRunner[] = [];
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** The Bot a call is from, as its Prompt start names it. */
const callerOf = (call: TextOptions) => /Your name: (\w+)/.exec(JSON.stringify(call.messages))?.[1];

const says = (text: string) =>
  round(toolCall({ name: "send_to_user", input: { text, endTurn: true } }));

/** A deferred tool's call, the way the Model must make it. */
const runs = (name: string, args: unknown) => toolCall({ name: "run_tool", input: { name, args } });

const assign = (botName: string, title = "Draft the post") =>
  round(
    runs("assign_work", { bot: botName, title, instructions: "Write 100 words about the launch." }),
  );

/** What an `assign_work` call's Turn says after it, so it ends. */
const quiet = round();

/** The Assignment id the newest Trigger text in a call names. */
const assignmentIdIn = (call: TextOptions) =>
  /Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/.exec(JSON.stringify(call.messages.slice(1)))![1]!;

/** A `finish_assignment` call on the Assignment that woke the Turn. */
const finish =
  (fields: Record<string, unknown> = { status: "done", outcome: "Drafted." }) =>
  (call: TextOptions) =>
    round(runs("finish_assignment", { id: assignmentIdIn(call), ...fields }));

/**
 * A user with an OpenAI key and Bots named `names`, each playing its own rounds, so which Bot runs
 * first doesn't matter. `manual` Bots wait for the test to release their chunks.
 */
async function bots<N extends string>(
  rounds: Record<N, Round[]>,
  {
    manual = [],
    reviewer,
    linkedCredentials,
    hostProviders,
  }: {
    manual?: NoInfer<N>[];
    reviewer?: FakeReviewer;
    /** Every Bot runs on the linked plan. */
    linkedCredentials?: TestDepsOverrides["linkedCredentials"];
    hostProviders?: TestDepsOverrides["hostProviders"];
  } = {},
) {
  const names = Object.keys(rounds) as N[];
  const fakes = Object.fromEntries(
    names.map((name) => [
      name,
      createFakeAdapter({ rounds: rounds[name], manual: manual.includes(name) }),
    ]),
  ) as Record<N, FakeAdapter>;
  const adapter: AnyTextAdapter = {
    ...fakes[names[0]!].adapter,
    chatStream: (options: TextOptions) => {
      const name = callerOf(options) as N;
      return fakes[name].adapter.chatStream(options);
    },
  };
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    adapterFor: () => adapter,
    linkedCredentials,
    hostProviders,
    ...(reviewer && {
      computer: fakeComputerProvider().provider,
      reviewAdapterFor: () => reviewer.adapter,
      memory: false,
    }),
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  // A stored key comes before a linked plan, so a test of the plan has none.
  if (!linkedCredentials) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const created = {} as Record<N, { id: string; name: string }>;
  for (const name of names) {
    created[name] = await client.bots.create({
      name,
      model: linkedCredentials ? planModel : model,
    });
  }
  const tell = (name: N, text: string) =>
    client.bots.send({ botId: created[name].id, id: uuidv7(), text });
  return { fakes, deps, user, client, bots: created, tell };
}

/** What the tool call a Bot made answered, as its next call was sent it. */
const toolResultsIn = (call: TextOptions | undefined) =>
  (call?.messages ?? []).filter((entry) => entry.role === "tool").map((entry) => entry.content);

const triggersOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTrigger)
    .where(eq(botTrigger.botId, botId))
    .orderBy(asc(botTrigger.receivedAt));

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt));

/** A log without its rows of spend: the changes to the Assignment. */
const changesIn = <Row extends { calls: number | null }>(log: Row[]) =>
  log.filter((row) => row.calls === null);

const statusesOf = async (botId: string) => (await turnsOf(botId)).map((turn) => turn.status);

describe("assigning work to a Bot", () => {
  it(
    "hands work over with no Room: the Bot wakes in its 1:1, stays working past its Turn, finishes by tool, and the assigner wakes with the result",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, quiet],
        Writer: [
          quiet,
          finish({
            status: "done",
            outcome: "Drafted.",
            for_customer: "It's ready.",
            when: "2026-11-05T09:00:00+00:00",
          }),
          quiet,
        ],
      });

      await tell("Scout", "Get the post written.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

      // The Trigger went through the Router, into Writer's own 1:1.
      const writer = await client.bots.get({ botId: b.Writer.id });
      const [trigger] = await triggersOf(b.Writer.id);
      expect(trigger).toMatchObject({ source: "assignment", channel: "assignment", hops: 0 });
      const [own] = await getTestDb()
        .select({ conversationId: bot.conversationId })
        .from(bot)
        .where(eq(bot.id, b.Writer.id));
      expect(trigger!.conversationId).toBe(own!.conversationId);
      expect(writer.turns).toHaveLength(1);
      expect(writer.turns[0]!.triggers[0]!.source).toBe("assignment");

      // It read the work, marked as the assigner's words and not the user's.
      const woke = JSON.stringify(fakes.Writer.calls[0]!.messages.slice(1));
      expect(woke).toContain("Draft the post");
      expect(woke).toContain("Write 100 words about the launch.");
      expect(woke).toContain("Scout's words, not the user's");

      // The Turn ended and the Assignment did not.
      const [working] = await client.assignments.list({ botId: b.Writer.id });
      expect(working).toMatchObject({
        title: "Draft the post",
        instructions: "Write 100 words about the launch.",
        status: "working",
        result: null,
        assignerBotId: b.Scout.id,
        assignerName: "Scout",
        assignerTrusted: true,
        overdueAt: null,
        endedAt: null,
      });

      // A later Turn finishes it; the assigner wakes with the result.
      await tell("Writer", "How's it going?");
      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Writer.id }))[0]?.status, poll)
        .toBe("done");
      const [done] = await client.assignments.list({ botId: b.Writer.id });
      expect(done!.result).toEqual({
        outcome: "Drafted.",
        forCustomer: "It's ready.",
        when: "2026-11-05T09:00:00+00:00",
      });
      expect(done!.endedAt).toBeInstanceOf(Date);

      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
      const results = JSON.stringify(fakes.Scout.calls.at(-1)!.messages.slice(1));
      expect(results).toContain("Drafted.");
      expect(results).toContain("It's ready.");
      expect(results).toContain("Writer's words, not the user's");
      const scoutTriggers = await triggersOf(b.Scout.id);
      expect(scoutTriggers.at(-1)).toMatchObject({ source: "assignment", channel: "assignment" });
    },
    timeout,
  );

  it(
    "offers its tools as deferred ones, and says for_customer may be shown to a Customer",
    async () => {
      const {
        fakes,
        tell,
        bots: b,
      } = await bots({
        Scout: [
          round(toolCall({ name: "describe_tool", input: { name: "finish_assignment" } })),
          quiet,
        ],
      });

      await tell("Scout", "Hello.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);

      const first = fakes.Scout.calls[0]!;
      const sent = (first.tools ?? []).map((tool) => tool.name);
      expect(sent).not.toContain("assign_work");
      expect(sent).not.toContain("finish_assignment");
      const listed = JSON.stringify(first.messages[0]);
      expect(listed).toContain("assign_work:");
      expect(listed).toContain("finish_assignment:");
      expect(JSON.stringify(toolResultsIn(fakes.Scout.calls[1]))).toMatch(
        /for_customer[^}]*may be shown to a Customer/,
      );
    },
    timeout,
  );

  it(
    "refuses itself, a name that is none of the owner's Bots, another user's Bot, and a Bot that can't work",
    async () => {
      const {
        fakes,
        client,
        deps,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Scout"), assign("Nobody"), assign("Stranger"), assign("Writer"), quiet],
        Writer: [],
      });
      const stranger = await insertUser();
      await saveCredentials(deps, stranger.id, {
        service: "openai",
        fields: { apiKey: "openai-test-key" },
        hint: "…-key",
        verified: true,
      });
      await chatRpc({ user: stranger, deps }).bots.create({ name: "Stranger", model });
      // Writer runs on a Model the user has no credentials for.
      await getTestDb()
        .update(bot)
        .set({ model: "anthropic:claude-sonnet-5-5" })
        .where(eq(bot.id, b.Writer.id));

      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);

      const answers = fakes.Scout.calls.map((call) => JSON.stringify(toolResultsIn(call).at(-1)));
      expect(answers[1]).toMatch(/yourself/);
      // A wrong name is answered with the names it could have been.
      expect(answers[2]).toMatch(/Nobody.*Writer/);
      expect(answers[3]).toMatch(/Stranger.*Writer/);
      expect(answers[4]).toMatch(/Writer can't work/);
      for (const id of [b.Scout.id, b.Writer.id]) {
        expect(await client.assignments.list({ botId: id })).toEqual([]);
      }
      expect(await triggersOf(b.Writer.id)).toEqual([]);
    },
    timeout,
  );

  it(
    "hands work to another Bot sharing the caller's name, as that isn't itself",
    async () => {
      const { client, bots: b, tell } = await bots({ Twin: [assign("Twin"), quiet, quiet] });
      const other = await client.bots.create({ name: "Twin", model });

      await tell("Twin", "Hand it on.");

      await expect
        .poll(async () => (await client.assignments.list({ botId: other.id })).length, poll)
        .toBe(1);
      expect(await client.assignments.list({ botId: b.Twin.id })).toEqual([]);
    },
    timeout,
  );

  it(
    "never interrupts a running Turn: the Assignment waits behind it and the next Turn takes it",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots(
        { Scout: [assign("Writer"), quiet], Writer: [says("Still on it."), quiet] },
        { manual: ["Writer"] },
      );

      await tell("Writer", "Do the thing.");
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(1);
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);

      // It waits in the queue, and the running Turn is still running.
      const [waiting] = await client.assignments.list({ botId: b.Writer.id });
      expect(waiting!.status).toBe("open");
      const tasks = await client.bots.tasks({ botId: b.Writer.id });
      expect(tasks.scheduled.triggers.map((trigger) => [trigger.source, trigger.label])).toEqual([
        ["assignment", "Draft the post"],
      ]);
      expect(await statusesOf(b.Writer.id)).toEqual(["running"]);

      await fakes.Writer.releaseAll();
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
      expect(fakes.Writer.calls).toHaveLength(2);
      const [working] = await client.assignments.list({ botId: b.Writer.id });
      expect(working!.status).toBe("working");
    },
    timeout,
  );
});

describe("work that a Stop, a pause or an unusable Model got in the way of", () => {
  it(
    "reaches the Bot's next Turn after a Stop took it, and moves to working then",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots(
        { Scout: [assign("Writer"), quiet], Writer: [says("Still on it."), quiet] },
        { manual: ["Writer"] },
      );
      await tell("Writer", "Do the thing.");
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(1);
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);

      await client.bots.stop({ botId: b.Writer.id });
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["stopped"]);
      // The Stop aborted the chunks it was waiting on, so this resolves only with later ones.
      void fakes.Writer.releaseAll();
      // A Stop starts nothing after it.
      expect((await client.assignments.list({ botId: b.Writer.id }))[0]!.status).toBe("open");

      await tell("Writer", "Carry on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["stopped", "complete"]);
      expect(JSON.stringify(fakes.Writer.calls[1]!.messages.slice(1))).toContain(
        "Write 100 words about the launch.",
      );
      expect((await client.assignments.list({ botId: b.Writer.id }))[0]!.status).toBe("working");
    },
    timeout,
  );

  it(
    "gives a paused assigner the result when it resumes",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots(
        { Scout: [assign("Writer"), quiet, quiet], Writer: [finish(), quiet] },
        { manual: ["Writer"] },
      );
      await tell("Scout", "Hand it on.");
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(1);
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);
      await client.bots.pause({ botId: b.Scout.id });

      await fakes.Writer.releaseAll();
      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Writer.id }))[0]?.status, poll)
        .toBe("done");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      expect(await statusesOf(b.Scout.id)).toEqual(["complete"]);

      await client.bots.resume({ botId: b.Scout.id });
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(fakes.Scout.calls.at(-1)!.messages)).toContain("Drafted.");

      // Delivered once: a second resume hands it over no more.
      await client.bots.pause({ botId: b.Scout.id });
      await client.bots.resume({ botId: b.Scout.id });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await statusesOf(b.Scout.id)).toEqual(["complete", "complete"]);
    },
    timeout,
  );

  it(
    "gives an assigner whose Model couldn't run the result in its next Turn",
    async () => {
      const {
        fakes,

        bots: b,
        tell,
      } = await bots(
        { Scout: [assign("Writer"), quiet, quiet], Writer: [finish(), quiet] },
        { manual: ["Writer"] },
      );
      await tell("Scout", "Hand it on.");
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(1);
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);
      const setModel = (to: string) =>
        getTestDb().update(bot).set({ model: to }).where(eq(bot.id, b.Scout.id));
      await setModel("anthropic:claude-sonnet-5-5");

      await fakes.Writer.releaseAll();
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      expect(await statusesOf(b.Scout.id)).toEqual(["complete"]);

      await setModel(model);
      await tell("Scout", "Any news?");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(fakes.Scout.calls.at(-1)!.messages)).toContain("Drafted.");
    },
    timeout,
  );

  it(
    "takes the work in the next Turn when a reset couldn't wake the Bot, though it was working",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({ Scout: [assign("Writer"), quiet], Writer: [quiet, quiet] });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const setModel = (to: string) =>
        getTestDb().update(bot).set({ model: to }).where(eq(bot.id, b.Writer.id));
      await setModel("anthropic:claude-sonnet-5-5");

      await client.bots.reset({ botId: b.Writer.id, name: "Writer" });
      // Give a wrongly woken Writer the time to start.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await statusesOf(b.Writer.id)).toEqual(["complete"]);

      await setModel(model);
      await tell("Writer", "Hello.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(fakes.Writer.calls[1]!.messages.slice(1))).toContain(
        "Write 100 words about the launch.",
      );
    },
    timeout,
  );

  it(
    "finishes though the assigner's Host hook throws, and the result comes in its next Turn",
    async () => {
      const linked = { broken: false };
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots(
        { Scout: [assign("Writer"), quiet, quiet], Writer: [finish(), quiet] },
        {
          manual: ["Writer"],
          hostProviders,
          linkedCredentials: async () => {
            if (linked.broken) throw new Error("The Host's hook failed");
            return { apiKey: "chatgpt-access-token" };
          },
        },
      );
      // Writer runs on the Host's Model, which asks no hook; Scout stays on the plan.
      await getTestDb().update(bot).set({ model: hostModel }).where(eq(bot.id, b.Writer.id));
      await tell("Scout", "Hand it on.");
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(1);
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);
      linked.broken = true;

      await fakes.Writer.releaseAll();
      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Writer.id }))[0]?.status, poll)
        .toBe("done");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      expect(await statusesOf(b.Scout.id)).toEqual(["complete"]);

      linked.broken = false;
      await tell("Scout", "Any news?");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(fakes.Scout.calls.at(-1)!.messages)).toContain("Drafted.");
    },
    timeout,
  );

  it(
    "resumes a Bot with open Assignments though the Host hook throws",
    async () => {
      const linked = { broken: false };
      const {
        client,
        bots: b,
        tell,
      } = await bots(
        { Scout: [assign("Writer"), quiet], Writer: [quiet] },
        {
          linkedCredentials: async () => {
            if (linked.broken) throw new Error("The Host's hook failed");
            return { apiKey: "chatgpt-access-token" };
          },
        },
      );
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      await client.bots.pause({ botId: b.Writer.id });
      linked.broken = true;

      await client.bots.resume({ botId: b.Writer.id });

      const { bot: resumed } = await client.bots.get({ botId: b.Writer.id });
      expect(resumed.pausedAt).toBeNull();
      expect((await client.assignments.list({ botId: b.Writer.id }))[0]!.status).toBe("working");
    },
    timeout,
  );
});

describe("finishing an Assignment", () => {
  it(
    "can fail with a reason, which wakes the assigner, and is refused once ended",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, quiet],
        Writer: [finish({ status: "failed", outcome: "No access to the CMS." }), finish(), quiet],
      });

      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

      const [failed] = await client.assignments.list({ botId: b.Writer.id });
      expect(failed).toMatchObject({
        status: "failed",
        result: { outcome: "No access to the CMS." },
      });
      expect(JSON.stringify(fakes.Scout.calls.at(-1)!.messages)).toContain("No access to the CMS.");
      // The second finish was refused, and changed nothing.
      expect(JSON.stringify(toolResultsIn(fakes.Writer.calls[2]).at(-1))).toMatch(/already ended/);
    },
    timeout,
  );

  it(
    "refuses a Bot that isn't the one assigned, and the assigner cannot finish its own handoff",
    async () => {
      let id = "";
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [
          assign("Writer"),
          quiet,
          () => round(runs("finish_assignment", { id, status: "done", outcome: "Mine now." })),
          quiet,
        ],
        Writer: [
          (call) => {
            id = assignmentIdIn(call);
            return quiet;
          },
        ],
      });

      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      await tell("Scout", "Finish it yourself.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);

      expect(JSON.stringify(toolResultsIn(fakes.Scout.calls[3]).at(-1))).toMatch(
        /No Assignment.*assigned to you/,
      );
      const [row] = await client.assignments.list({ botId: b.Writer.id });
      expect(row!.status).toBe("working");
      expect(row!.result).toBeNull();
    },
    timeout,
  );
});

describe("what the owner sees", () => {
  it(
    "lists the Bot's Assignments in its Tasks view, in progress then done, and logs each status change",
    async () => {
      const {
        client,
        deps,
        user,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, quiet],
        Writer: [quiet, finish(), quiet],
      });

      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

      const during = await client.bots.tasks({ botId: b.Writer.id });
      expect(during.inProgress.assignments.map((row) => row.status)).toEqual(["working"]);
      expect(during.done.assignments).toEqual([]);

      await tell("Writer", "Finish up.");
      await expect
        .poll(
          async () =>
            (await client.bots.tasks({ botId: b.Writer.id })).done.assignments.map(
              (row) => row.status,
            ),
          poll,
        )
        .toEqual(["done"]);
      const after = await client.bots.tasks({ botId: b.Writer.id });
      expect(after.inProgress.assignments).toEqual([]);

      const exported = (await exportUserData(deps, user.id)).bot as {
        assignments: {
          log: ({ calls: number | null; turnId: string | null } & Record<string, unknown>)[];
        }[];
      };
      const [assignment] = exported.assignments;
      expect(changesIn(assignment!.log)).toMatchObject([
        { status: "open", actor: "bot", actorBotId: b.Scout.id },
        { status: "working", actor: "system", actorBotId: null },
        { status: "done", actor: "bot", actorBotId: b.Writer.id },
      ]);
      for (const row of changesIn(assignment!.log)) expect(row.turnId).toEqual(expect.any(String));
    },
    timeout,
  );

  it(
    "tells a following thread of the Assignment through the change log, after the Message before it",
    async () => {
      const {
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet],
        Writer: [says("Hello there."), quiet],
      });
      await tell("Writer", "Say hello.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const { messages } = await client.bots.get({ botId: b.Writer.id });

      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);

      const [row] = await client.assignments.list({ botId: b.Writer.id });
      expect(row!.afterMessageId).toBe(messages.at(-1)!.id);
      const { conversationId } = (
        await getTestDb()
          .select({ conversationId: bot.conversationId })
          .from(bot)
          .where(eq(bot.id, b.Writer.id))
      )[0]!;
      const read = await client.conversations.changes({ conversationId, since: 0 });
      if (read.reload) throw new Error("The change log asked for a reload");
      const change = read.changes.find((entry) => entry.kind === "assignment");
      // The thread reads the list afresh on it, so the change carries nothing.
      expect(change).toMatchObject({ refId: row!.id, data: null });
    },
    timeout,
  );

  it(
    "is refused another user's Bot's Assignments",
    async () => {
      const { deps, bots: b } = await bots({ Scout: [] });
      const other = chatRpc({ user: await insertUser(), deps });
      await expect(other.assignments.list({ botId: b.Scout.id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    },
    timeout,
  );

  it(
    "keeps an open Assignment through the Bot's reset and wakes the Bot on it afresh",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, quiet],
        Writer: [quiet, finish(), quiet],
      });

      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

      await client.bots.reset({ botId: b.Writer.id, name: "Writer" });

      // The reset woke it afresh, and it read the work, after the reset mark.
      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Writer.id }))[0]?.status, poll)
        .toBe("done");
      expect(JSON.stringify(fakes.Writer.calls[1]!.messages.slice(1))).toContain(
        "Write 100 words about the launch.",
      );
    },
    timeout,
  );

  it(
    "wakes a paused Bot's Assignment when it resumes, as nothing else would",
    async () => {
      const {
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, quiet],
        Writer: [finish(), quiet],
      });
      await client.bots.pause({ botId: b.Writer.id });

      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);
      expect((await client.assignments.list({ botId: b.Writer.id }))[0]!.status).toBe("open");
      expect(await turnsOf(b.Writer.id)).toEqual([]);

      await client.bots.resume({ botId: b.Writer.id });
      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Writer.id }))[0]?.status, poll)
        .toBe("done");
    },
    timeout,
  );

  it(
    "exports the user's Assignments, and deletes them with the user",
    async () => {
      const {
        deps,
        user,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet],
        Writer: [quiet],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

      const exported = (await exportUserData(deps, user.id)).bot as { assignments: unknown[] };
      expect(exported.assignments).toMatchObject([
        { title: "Draft the post", assignedBotId: b.Writer.id, assignerBotId: b.Scout.id },
      ]);

      await deleteUserData(deps, user.id);
      const left = await getTestDb()
        .select()
        .from(botAssignment)
        .where(eq(botAssignment.assignedBotId, b.Writer.id));
      expect(left).toEqual([]);
    },
    timeout,
  );
});

describe("Auto-review of an Assignment Turn", () => {
  it(
    "reads the Assignment as another Bot's words, never the user's",
    async () => {
      const reviewer = fakeReviewer();
      const { bots: b, tell } = await bots(
        {
          Scout: [assign("Writer"), quiet],
          Writer: [round(toolCall({ name: "shell", input: { command: "make test" } })), quiet],
        },
        { reviewer },
      );

      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

      expect(reviewer.calls).toHaveLength(1);
      const sent = (reviewer.calls[0]?.messages ?? [])
        .map((entry) => String(entry.content))
        .join("\n");
      expect(sent).toContain("- Another of the user's Bots handing work over");
      expect(sent).not.toContain("untrusted");
      expect(sent).toContain("that Bot's words, not the user's");
      expect(sent).not.toContain("A Helper's report");
    },
    timeout,
  );
});

describe("Rooms beside Assignments", () => {
  it(
    "leaves handoffs and the three-hop stop as they were, with an Assignment made mid-chain counting no hop",
    async () => {
      const { client, bots: b } = await bots({
        // Scout hands on in the Room and also assigns outside it.
        Scout: [
          round(
            runs("assign_work", { bot: "Ops", title: "Side job", instructions: "Do it." }),
            toolCall({
              name: "send_to_user",
              input: { text: "@Writer, over to you.", endTurn: true },
            }),
          ),
          says("@Writer, again."), // hop 4, stopped
          quiet,
        ],
        Writer: [says("@Ops, your turn.")],
        Ops: [quiet, says("@Scout, back to you.")],
      });
      const room = await client.rooms.create({
        name: "Launch",
        botIds: [b.Scout.id, b.Writer.id, b.Ops.id],
      });

      await client.rooms.send({ conversationId: room.conversationId, text: "@Scout, start." });

      const inRoom = async (botId: string) =>
        (await triggersOf(botId)).filter((row) => row.conversationId === room.conversationId);
      await expect
        .poll(async () => (await inRoom(b.Writer.id)).map((row) => row.hops), poll)
        .toEqual([1, 4]);
      expect((await inRoom(b.Writer.id))[1]).toMatchObject({
        source: "agent",
        skipReason: "hop_limit",
        turnId: null,
      });
      expect((await inRoom(b.Ops.id)).map((row) => row.hops)).toEqual([2]);
      expect((await inRoom(b.Scout.id)).map((row) => row.hops)).toEqual([0, 3]);
      // The Assignment woke Ops outside the Room, at no hop, and posted nothing there.
      const outside = (await triggersOf(b.Ops.id)).filter(
        (row) => row.conversationId !== room.conversationId,
      );
      expect(outside).toMatchObject([{ source: "assignment", hops: 0 }]);
      const { messages } = await client.rooms.get({ conversationId: room.conversationId });
      expect(messages.map((sent) => sent.text).join("\n")).not.toContain("Side job");
    },
    timeout,
  );
});

/** A tool call of the deferred kind on Assignment `id()`, read when its round is played. */
const onAssignment =
  (name: string, id: () => string, extra: Record<string, unknown> = {}) =>
  () =>
    round(runs(name, { id: id(), ...extra }));

/** The `changed` hints a Conversation gets. */
async function hintsOf(deps: TestDeps, conversationId: string) {
  const hints: string[] = [];
  await deps.pubsub.subscribe(conversationChannel(conversationId), (message) => {
    hints.push(message);
  });
  return hints;
}

const conversationOf = async (botId: string) =>
  (await getTestDb().select({ id: bot.conversationId }).from(bot).where(eq(bot.id, botId)))[0]!.id;

describe("following an Assignment's log", () => {
  it(
    "logs each change with its actor, the assigned Bot's notes and the Turn, and shows a Bot only its own Assignments",
    async () => {
      let id = "";
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, onAssignment("read_assignment", () => id), quiet],
        Writer: [
          (call) => {
            id = assignmentIdIn(call);
            return round(runs("add_assignment_note", { id, note: "Halfway there." }));
          },
          onAssignment("read_assignment", () => id),
          onAssignment("cancel_assignment", () => id),
          quiet,
        ],
        Ops: [
          onAssignment("read_assignment", () => id),
          onAssignment("add_assignment_note", () => id, { note: "Mine." }),
          onAssignment("cancel_assignment", () => id),
          quiet,
        ],
      });

      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

      // The owner reads who did what, in which Turn, and the note.
      const [row] = await client.assignments.list({ botId: b.Writer.id });
      expect(
        changesIn(row!.log).map((entry) => [
          entry.status,
          entry.actor,
          entry.actorName,
          entry.note,
        ]),
      ).toEqual([
        ["open", "bot", "Scout", null],
        ["working", "system", null, null],
        ["working", "bot", "Writer", "Halfway there."],
      ]);
      const [writerTurn] = await turnsOf(b.Writer.id);
      expect(changesIn(row!.log)[2]!.turnId).toBe(writerTurn!.id);

      // The assigned Bot reads its own, and can't cancel what it didn't start.
      const writerSaw = JSON.stringify(toolResultsIn(fakes.Writer.calls[2]));
      expect(writerSaw).toMatch(/assigned to you/);
      expect(writerSaw).toMatch(/Halfway there\./);
      expect(writerSaw).toMatch(/Scout/);
      expect(JSON.stringify(toolResultsIn(fakes.Writer.calls[3]).at(-1))).toMatch(
        /was started by you/,
      );

      // The assigner reads it too, and its log cannot be cancelled by a Bot that isn't part of it.
      await tell("Scout", "How is it going?");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(toolResultsIn(fakes.Scout.calls[3]).at(-1))).toMatch(
        /started by you[\s\S]*Halfway there\./,
      );

      // A Bot that isn't part of it is refused all three, as if it didn't exist.
      await tell("Ops", "Look at it.");
      await expect.poll(() => statusesOf(b.Ops.id), poll).toEqual(["complete"]);
      const refused = fakes.Ops.calls.map((call) => JSON.stringify(toolResultsIn(call).at(-1)));
      expect(refused[1]).toMatch(/not part of an Assignment/);
      expect(refused[2]).toMatch(/No Assignment with id .* is assigned to you/);
      expect(refused[3]).toMatch(/was started by you/);
      const [after] = await client.assignments.list({ botId: b.Writer.id });
      expect(after!.status).toBe("working");
      expect(changesIn(after!.log)).toHaveLength(3);
    },
    timeout,
  );

  it(
    "offers no way to create, edit or remove a log row, or to create an Assignment, to the owner",
    async () => {
      expect(Object.keys(botContract.assignments).sort()).toEqual(["cancel", "list", "raiseLimit"]);
    },
    timeout,
  );
});

describe("cancelling an Assignment", () => {
  it(
    "lets the owner cancel any one: it logs, wakes the waiting assigner, tells the assigned Bot, and refuses its finish",
    async () => {
      const {
        fakes,
        deps,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, quiet],
        Writer: [quiet, finish(), quiet],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const [working] = await client.assignments.list({ botId: b.Writer.id });
      const hints = await Promise.all(
        [b.Writer.id, b.Scout.id].map(async (botId) => hintsOf(deps, await conversationOf(botId))),
      );

      await client.assignments.cancel({ botId: b.Writer.id, assignmentId: working!.id });

      // Whoever was waiting is woken, and the one working on it learns of it.
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
      const [cancelled] = await client.assignments.list({ botId: b.Writer.id });
      expect(cancelled).toMatchObject({ status: "cancelled", result: null });
      expect(cancelled!.endedAt).toBeInstanceOf(Date);
      expect(cancelled!.log.at(-1)).toMatchObject({
        status: "cancelled",
        actor: "user",
        actorName: null,
        turnId: null,
      });
      expect(JSON.stringify(fakes.Scout.calls.at(-1)!.messages.slice(1))).toContain(
        "was cancelled by the user",
      );
      expect(JSON.stringify(fakes.Writer.calls[1]!.messages.slice(1))).toContain(
        "was cancelled by the user",
      );
      // Finishing it is refused and changes nothing.
      expect(JSON.stringify(toolResultsIn(fakes.Writer.calls[2]).at(-1))).toMatch(
        /was cancelled, so it can't be finished/,
      );
      const [still] = await client.assignments.list({ botId: b.Writer.id });
      expect(still).toMatchObject({ status: "cancelled", result: null });
      expect(still!.log.filter((entry) => entry.status === "cancelled")).toHaveLength(1);

      // Both threads were hinted once it committed.
      for (const events of hints) expect(events).toContain(JSON.stringify({ type: "changed" }));

      // Once ended, it can't be cancelled again.
      await expect(
        client.assignments.cancel({ botId: b.Writer.id, assignmentId: working!.id }),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "error.assignmentEnded" } });
    },
    timeout,
  );

  it(
    "hints both threads once the owner's cancel has committed, when no Turn would hint them",
    async () => {
      const {
        deps,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet],
        Writer: [quiet],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const [row] = await client.assignments.list({ botId: b.Writer.id });
      // Paused, neither Bot runs a Turn, so any hint of their threads is the cancel's.
      await client.bots.pause({ botId: b.Writer.id });
      await client.bots.pause({ botId: b.Scout.id });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const hints = await Promise.all(
        [b.Writer.id, b.Scout.id].map(async (botId) => hintsOf(deps, await conversationOf(botId))),
      );

      await client.assignments.cancel({ botId: b.Writer.id, assignmentId: row!.id });

      for (const events of hints) {
        await expect.poll(() => events, poll).toContain(JSON.stringify({ type: "changed" }));
      }
    },
    timeout,
  );

  it(
    "is refused for another user's Assignment, and under another Bot's id",
    async () => {
      const {
        deps,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet],
        Writer: [quiet],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const [row] = await client.assignments.list({ botId: b.Writer.id });
      const stranger = chatRpc({ user: await insertUser(), deps });
      const code = { code: "NOT_FOUND" };

      await expect(
        stranger.assignments.cancel({ botId: b.Writer.id, assignmentId: row!.id }),
      ).rejects.toMatchObject(code);
      await expect(
        client.assignments.cancel({ botId: b.Scout.id, assignmentId: row!.id }),
      ).rejects.toMatchObject(code);
      await expect(
        client.assignments.cancel({ botId: b.Writer.id, assignmentId: uuidv7() }),
      ).rejects.toMatchObject(code);
      expect((await client.assignments.list({ botId: b.Writer.id }))[0]!.status).toBe("working");
    },
    timeout,
  );

  it(
    "lets a Bot cancel what it started, telling the assigned Bot, and hints the assigned Bot's thread",
    async () => {
      let id = "";
      const {
        fakes,
        deps,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, onAssignment("cancel_assignment", () => id), quiet],
        Writer: [
          (call) => {
            id = assignmentIdIn(call);
            return quiet;
          },
          quiet,
        ],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      // Paused, the Writer runs no Turn, so a hint of its thread can only be the cancel's.
      await client.bots.pause({ botId: b.Writer.id });
      const hints = await hintsOf(deps, await conversationOf(b.Writer.id));

      await tell("Scout", "Never mind that.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);

      const [cancelled] = await client.assignments.list({ botId: b.Writer.id });
      expect(cancelled!.status).toBe("cancelled");
      expect(cancelled!.log.at(-1)).toMatchObject({ actor: "bot", actorName: "Scout" });
      expect(cancelled!.log.at(-1)!.turnId).toEqual(expect.any(String));
      expect(fakes.Scout.calls).toHaveLength(4);
      await expect.poll(() => hints, poll).toContain(JSON.stringify({ type: "changed" }));
    },
    timeout,
  );

  it(
    "causes no further work when it is cancelled while waiting behind another Turn",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots(
        { Scout: [assign("Writer"), quiet, quiet], Writer: [says("Still on it.")] },
        { manual: ["Writer"] },
      );
      await tell("Writer", "Do the thing.");
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(1);
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);
      const [waiting] = await client.assignments.list({ botId: b.Writer.id });
      expect(waiting!.status).toBe("open");

      await client.assignments.cancel({ botId: b.Writer.id, assignmentId: waiting!.id });
      await fakes.Writer.releaseAll();

      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      // The Turn behind it never comes: Writer never read the work or the cancel.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await statusesOf(b.Writer.id)).toEqual(["complete"]);
      expect(fakes.Writer.calls).toHaveLength(1);
      const triggers = await triggersOf(b.Writer.id);
      expect(triggers.map((trigger) => [trigger.source, trigger.skipReason])).toEqual([
        ["user", null],
        ["assignment", "cancelled"],
      ]);
      const [after] = await client.assignments.list({ botId: b.Writer.id });
      expect(after!.status).toBe("cancelled");
      // The waiting assigner was woken all the same.
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
    },
    timeout,
  );
});

describe("the Tasks count", () => {
  it(
    "counts an Assignment in progress with no Turn running and no Trigger waiting",
    async () => {
      const {
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet],
        Writer: [quiet],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

      const tasks = await client.bots.tasks({ botId: b.Writer.id });

      expect(tasks.inProgress.assignments).toHaveLength(1);
      expect(taskCount(tasks)).toBe(1);
    },
    timeout,
  );
});

describe("a note in the log", () => {
  it(
    "hints the assigned Bot's thread once it is committed, and is refused once the Assignment ended",
    async () => {
      const {
        deps,
        client,
        user,
        bots: b,
        tell,
      } = await bots({ Scout: [assign("Writer"), quiet], Writer: [quiet] });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const [row] = await client.assignments.list({ botId: b.Writer.id });
      const [turn] = await turnsOf(b.Writer.id);
      const note = assignmentTools(
        deps,
        { id: turn!.id, botId: b.Writer.id, userId: user.id },
        <T>(_name: string, _id: string | undefined, write: (tx: never) => Promise<T>) =>
          getTestDb().transaction((tx) => write(tx as never)),
      ).find((tool) => tool.name === "add_assignment_note")!;
      // The Turn's own hints have all arrived by now.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const hints = await hintsOf(deps, await conversationOf(b.Writer.id));

      await note.execute!({ id: row!.id, note: "Started." }, undefined);

      await expect.poll(() => hints, poll).toContain(JSON.stringify({ type: "changed" }));
      const [noted] = await client.assignments.list({ botId: b.Writer.id });
      expect(noted!.log.at(-1)).toMatchObject({ actor: "bot", note: "Started." });

      await client.assignments.cancel({ botId: b.Writer.id, assignmentId: row!.id });
      expect(await note.execute!({ id: row!.id, note: "Too late." }, undefined)).toMatchObject({
        error: expect.stringMatching(/was cancelled, so it takes no more notes/),
      });
      const [after] = await client.assignments.list({ botId: b.Writer.id });
      expect(after!.log.map((entry) => entry.note)).not.toContain("Too late.");
    },
    timeout,
  );
});

describe("a cancel a Bot missed", () => {
  const cancelNote = "was cancelled by the user";

  /** Scout hands Writer the work, and Writer reads it in one Turn, so the Assignment is working. */
  async function working() {
    const made = await bots({ Scout: [assign("Writer"), quiet, quiet], Writer: [quiet, quiet] });
    await made.tell("Scout", "Hand it on.");
    await expect.poll(() => statusesOf(made.bots.Writer.id), poll).toEqual(["complete"]);
    const [row] = await made.client.assignments.list({ botId: made.bots.Writer.id });
    return { ...made, id: row!.id };
  }

  it(
    "tells a paused assigner when it resumes, once",
    async () => {
      const { fakes, client, bots: b, id } = await working();
      await client.bots.pause({ botId: b.Scout.id });

      await client.assignments.cancel({ botId: b.Writer.id, assignmentId: id });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await statusesOf(b.Scout.id)).toEqual(["complete"]);

      await client.bots.resume({ botId: b.Scout.id });
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(fakes.Scout.calls.at(-1)!.messages)).toContain(cancelNote);

      await client.bots.pause({ botId: b.Scout.id });
      await client.bots.resume({ botId: b.Scout.id });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await statusesOf(b.Scout.id)).toEqual(["complete", "complete"]);
    },
    timeout,
  );

  it(
    "tells an assigner whose Model couldn't run in its next Turn",
    async () => {
      const { fakes, client, bots: b, tell, id } = await working();
      const setModel = (to: string) =>
        getTestDb().update(bot).set({ model: to }).where(eq(bot.id, b.Scout.id));
      await setModel("anthropic:claude-sonnet-5-5");

      await client.assignments.cancel({ botId: b.Writer.id, assignmentId: id });
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
      expect(await statusesOf(b.Scout.id)).toEqual(["complete"]);

      await setModel(model);
      await tell("Scout", "Any news?");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(fakes.Scout.calls.at(-1)!.messages)).toContain(cancelNote);
    },
    timeout,
  );

  it(
    "tells a paused assigned Bot that had read it when it resumes",
    async () => {
      const { fakes, client, bots: b, id } = await working();
      await client.bots.pause({ botId: b.Writer.id });

      await client.assignments.cancel({ botId: b.Writer.id, assignmentId: id });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await statusesOf(b.Writer.id)).toEqual(["complete"]);

      await client.bots.resume({ botId: b.Writer.id });
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(fakes.Writer.calls.at(-1)!.messages)).toContain(cancelNote);
    },
    timeout,
  );

  it(
    "tells a paused assigned Bot of its assigner's cancel when it resumes, and the assigner of nothing",
    async () => {
      let id = "";
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, onAssignment("cancel_assignment", () => id), quiet],
        Writer: [
          (call) => {
            id = assignmentIdIn(call);
            return quiet;
          },
          quiet,
        ],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      await client.bots.pause({ botId: b.Writer.id });

      await tell("Scout", "Never mind that.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);
      expect(await statusesOf(b.Writer.id)).toEqual(["complete"]);

      await client.bots.resume({ botId: b.Writer.id });
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(fakes.Writer.calls.at(-1)!.messages)).toContain(
        "was cancelled by Scout",
      );
      // Scout cancelled it itself, so it is owed no notice.
      await client.bots.pause({ botId: b.Scout.id });
      await client.bots.resume({ botId: b.Scout.id });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await statusesOf(b.Scout.id)).toEqual(["complete", "complete"]);
    },
    timeout,
  );
});

describe("splitting an Assignment into child Assignments", () => {
  it(
    "opens a child the owner sees linked to its parent, which is blocked until the child ends and its Bot wakes with the result",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, quiet],
        Writer: [assign("Editor", "Check the facts"), quiet, quiet],
        Editor: [finish({ status: "done", outcome: "Facts check out." }), quiet],
      });

      await tell("Scout", "Hand it on.");

      await expect.poll(() => statusesOf(b.Editor.id), poll).toEqual(["complete"]);
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
      const [parent] = await client.assignments.list({ botId: b.Writer.id });
      const [child] = await client.assignments.list({ botId: b.Editor.id });

      // The owner sees the link from both ends.
      expect(child!.parent).toEqual({ id: parent!.id, title: "Draft the post", botName: "Writer" });
      expect(parent!.parent).toBeNull();
      expect(parent!.children).toEqual([
        { id: child!.id, title: "Check the facts", status: "done", botName: "Editor" },
      ]);

      // The parent showed blocked while the child ran, and came back when it ended.
      expect(parent!.status).toBe("working");
      expect(changesIn(parent!.log).map((entry) => [entry.status, entry.actor])).toEqual([
        ["open", "bot"],
        ["working", "system"],
        ["blocked", "system"],
        ["working", "system"],
      ]);

      // Its Bot woke with the child's result, told which of its Assignments it was part of.
      const woke = JSON.stringify(fakes.Writer.calls.at(-1)!.messages.slice(1));
      expect(woke).toContain("Facts check out.");
      expect(woke).toContain(`part of your Assignment ${parent!.id}`);
    },
    timeout,
  );

  /** What each of a Bot's tool calls answered, as its next call was sent it. */
  const answersIn = (fake: FakeAdapter) =>
    JSON.stringify(fake.calls.map((call) => toolResultsIn(call).at(-1)));

  /** A `finish_assignment` call on the Assignment the newest Trigger names, not the first. */
  const finishNewest = (call: TextOptions) => {
    const ids = [
      ...JSON.stringify(call.messages.slice(1)).matchAll(/Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/g),
    ];
    return round(
      runs("finish_assignment", { id: ids.at(-1)![1]!, status: "done", outcome: "Drafted." }),
    );
  };

  const titled = (botName: string, title: string, parent?: string) =>
    round(runs("assign_work", { bot: botName, title, instructions: "Do it.", parent }));

  const statusOf = async (
    client: Awaited<ReturnType<typeof bots>>["client"],
    botId: string,
    index = 0,
  ) => (await client.assignments.list({ botId }))[index]?.status;

  it(
    "refuses a chain deeper than 3 with a reason the Bot can read",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [titled("Bea", "one"), quiet, quiet],
        Bea: [titled("Cid", "two"), quiet, quiet],
        Cid: [titled("Dee", "three"), quiet, quiet],
        Dee: [titled("Eve", "four"), quiet, quiet],
        Eve: [quiet],
      });

      await tell("Ann", "Start it.");

      await expect.poll(() => answersIn(fakes.Dee), poll).toMatch(/stops at 3 deep/);
      await expect.poll(() => statusesOf(b.Dee.id), poll).toEqual(["complete"]);
      // Eve never heard of it.
      expect(fakes.Eve.calls).toHaveLength(0);
      expect(await client.assignments.list({ botId: b.Eve.id })).toEqual([]);
      // The third is still working, not blocked: nothing split off from it.
      const [third] = await client.assignments.list({ botId: b.Dee.id });
      expect(third).toMatchObject({ title: "three", status: "working", children: [] });
    },
    timeout,
  );

  it(
    "bounds a Bot-to-Bot cycle by the same limit, though no Bot names a parent",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [titled("Bea", "one"), quiet, titled("Bea", "three"), quiet, quiet],
        Bea: [titled("Ann", "two"), quiet, titled("Ann", "four"), quiet, quiet],
      });

      await tell("Ann", "Start it.");

      await expect.poll(() => answersIn(fakes.Bea), poll).toMatch(/stops at 3 deep/);
      const [one, three] = await client.assignments.list({ botId: b.Bea.id });
      const [two, four] = await client.assignments.list({ botId: b.Ann.id });
      expect(four).toBeUndefined();
      expect(two!.parent!.id).toBe(one!.id);
      expect(three!.parent!.id).toBe(two!.id);
    },
    timeout,
  );

  it(
    "bounds two Bots trading results, and starts a new chain when the user asks",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [
          titled("Bea", "one"),
          quiet,
          titled("Bea", "two"),
          quiet,
          titled("Bea", "three"),
          quiet,
          titled("Bea", "four"),
          quiet,
          titled("Bea", "fresh"),
          quiet,
          quiet,
        ],
        Bea: [finishNewest, quiet, finishNewest, quiet, finishNewest, quiet, quiet],
      });

      await tell("Ann", "Start it.");

      await expect.poll(() => answersIn(fakes.Ann), poll).toMatch(/stops at 3 deep/);
      const handed = await client.assignments.list({ botId: b.Bea.id });
      expect(handed.map((row) => row.title)).toEqual(["one", "two", "three"]);
      // A result that wakes a Bot carries on a chain, but isn't the parent of what comes next.
      expect(handed.map((row) => row.parent)).toEqual([null, null, null]);

      await expect.poll(() => statusesOf(b.Ann.id), poll).toEqual(Array(4).fill("complete"));
      await tell("Ann", "One more, please.");

      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Bea.id })).at(-1)!.title, poll)
        .toBe("fresh");
    },
    timeout,
  );

  it(
    "keeps the parent blocked until its last open child ends, however many it splits off",
    async () => {
      const dee: Round[] = [quiet];
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [titled("Bea", "parent"), quiet, quiet],
        Bea: [
          round(
            runs("assign_work", { bot: "Cid", title: "first", instructions: "One." }),
            runs("assign_work", { bot: "Dee", title: "second", instructions: "Two." }),
          ),
          quiet,
          quiet,
          quiet,
        ],
        Cid: [finishNewest, quiet],
        Dee: dee,
      });

      await tell("Ann", "Hand it on.");

      await expect.poll(() => statusesOf(b.Cid.id), poll).toEqual(["complete"]);
      await expect.poll(() => statusesOf(b.Dee.id), poll).toEqual(["complete"]);
      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Bea.id }))[0]!.children, poll)
        .toMatchObject([
          { title: "first", status: "done" },
          { title: "second", status: "working" },
        ]);
      expect(await statusOf(client, b.Bea.id)).toBe("blocked");

      // The parent's thread hears of each child, though its own status didn't change for all.
      const changes = async () => {
        const read = await client.conversations.changes({
          conversationId: await conversationOf(b.Bea.id),
          since: 0,
        });
        return read.reload ? [] : read.changes.filter((row) => row.kind === "assignment");
      };
      // Made: open, working, blocked, then the second child, then the first one's end.
      expect(await changes()).toHaveLength(5);

      dee.push(finishNewest, quiet);
      await tell("Dee", "Finish it.");

      await expect.poll(() => statusOf(client, b.Bea.id), poll).toBe("working");
      const [after] = await client.assignments.list({ botId: b.Bea.id });
      expect(changesIn(after!.log).filter((entry) => entry.status === "blocked")).toHaveLength(1);
      expect(changesIn(after!.log).at(-1)).toMatchObject({ status: "working", actor: "system" });
      expect(fakes.Ann.calls).toHaveLength(2);
      expect(await changes()).toHaveLength(6);
    },
    timeout,
  );

  it(
    "leaves the parent's Bot to decide when a child fails",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [titled("Bea", "parent"), quiet, quiet],
        Bea: [titled("Cid", "Check the facts"), quiet, quiet, quiet],
        Cid: [finish({ status: "failed", outcome: "No sources." }), quiet],
      });

      await tell("Ann", "Hand it on.");

      await expect.poll(() => statusesOf(b.Bea.id), poll).toEqual(["complete", "complete"]);
      const [parent] = await client.assignments.list({ botId: b.Bea.id });
      expect(parent).toMatchObject({ status: "working", result: null });
      expect(parent!.children).toMatchObject([{ status: "failed" }]);
      expect(JSON.stringify(fakes.Bea.calls.at(-1)!.messages.slice(1))).toContain("No sources.");
      // Ann, which started the parent, hears nothing: it hasn't ended.
      expect(await statusesOf(b.Ann.id)).toEqual(["complete"]);
    },
    timeout,
  );

  it(
    "unblocks the parent and wakes its Bot when the owner cancels a child, and when its Bot does",
    async () => {
      const bea: Round[] = [
        round(
          runs("assign_work", { bot: "Cid", title: "first", instructions: "One." }),
          runs("assign_work", { bot: "Dee", title: "second", instructions: "Two." }),
        ),
        quiet,
      ];
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [titled("Bea", "parent"), quiet],
        Bea: bea,
        Cid: [quiet],
        Dee: [quiet, quiet],
      });
      await tell("Ann", "Hand it on.");
      await expect.poll(() => statusesOf(b.Cid.id), poll).toEqual(["complete"]);
      await expect.poll(() => statusesOf(b.Dee.id), poll).toEqual(["complete"]);
      const [first] = await client.assignments.list({ botId: b.Cid.id });
      const [second] = await client.assignments.list({ botId: b.Dee.id });

      bea.push(quiet);
      await client.assignments.cancel({ botId: b.Cid.id, assignmentId: first!.id });
      await expect.poll(() => statusesOf(b.Bea.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(fakes.Bea.calls.at(-1)!.messages.slice(1))).toContain(
        "was cancelled by the user",
      );
      // The other child is still open.
      expect(await statusOf(client, b.Bea.id)).toBe("blocked");

      bea.push(round(runs("cancel_assignment", { id: second!.id })), quiet);
      await tell("Bea", "Drop the other one too.");

      await expect.poll(() => statusOf(client, b.Bea.id), poll).toBe("working");
      expect(await statusOf(client, b.Dee.id)).toBe("cancelled");
    },
    timeout,
  );

  it(
    "takes a parent named in a Turn that didn't start from it, and refuses one the Bot can't split",
    async () => {
      const bea: Round[] = [quiet];
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [titled("Bea", "parent"), quiet, quiet],
        Bea: bea,
        Cid: [quiet, quiet],
      });
      await tell("Ann", "Hand it on.");
      await expect.poll(() => statusesOf(b.Bea.id), poll).toEqual(["complete"]);
      const [parent] = await client.assignments.list({ botId: b.Bea.id });

      bea.push(titled("Cid", "child", parent!.id), quiet);
      await tell("Bea", "Get help with that.");

      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Cid.id }))[0]?.parent?.id, poll)
        .toBe(parent!.id);
      expect(await statusOf(client, b.Bea.id)).toBe("blocked");

      bea.push(quiet);
      await client.assignments.cancel({ botId: b.Bea.id, assignmentId: parent!.id });
      await expect.poll(() => statusOf(client, b.Bea.id), poll).toBe("cancelled");
      await expect.poll(() => statusesOf(b.Bea.id), poll).toEqual(Array(3).fill("complete"));
      bea.push(titled("Cid", "too late", parent!.id), quiet);
      await tell("Bea", "One more.");
      await expect.poll(() => answersIn(fakes.Bea), poll).toMatch(/already ended/);
      await expect.poll(() => statusesOf(b.Bea.id), poll).toEqual(Array(4).fill("complete"));

      bea.push(titled("Cid", "not handed", uuidv7()), quiet);
      await tell("Bea", "And another.");
      await expect.poll(() => answersIn(fakes.Bea), poll).toMatch(/is assigned to you/);
      expect(await client.assignments.list({ botId: b.Cid.id })).toHaveLength(1);
    },
    timeout,
  );

  it(
    "asks which parent when a Turn took several Assignments, rather than guess",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [titled("Cid", "from Ann"), quiet],
        Bea: [titled("Cid", "from Bea"), quiet],
        Cid: [titled("Dee", "which?"), quiet],
        Dee: [quiet],
      });
      await client.bots.pause({ botId: b.Cid.id });
      await tell("Ann", "Hand it on.");
      await tell("Bea", "Hand it on.");
      await expect.poll(() => statusesOf(b.Ann.id), poll).toEqual(["complete"]);
      await expect.poll(() => statusesOf(b.Bea.id), poll).toEqual(["complete"]);

      await client.bots.resume({ botId: b.Cid.id });

      await expect.poll(() => answersIn(fakes.Cid), poll).toMatch(/say in parent which one/);
      expect(await client.assignments.list({ botId: b.Dee.id })).toEqual([]);
    },
    timeout,
  );

  it(
    "never makes another Bot's Assignment the parent, when a Bot told of its child's cancel assigns work",
    async () => {
      const cid: Round[] = [quiet];
      const {
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [titled("Bea", "parent"), quiet, quiet],
        Bea: [
          round(
            runs("assign_work", { bot: "Cid", title: "first", instructions: "One." }),
            runs("assign_work", { bot: "Dee", title: "second", instructions: "Two." }),
          ),
          quiet,
          quiet,
        ],
        Cid: cid,
        Dee: [quiet, quiet],
      });
      await tell("Ann", "Hand it on.");
      await expect.poll(() => statusesOf(b.Cid.id), poll).toEqual(["complete"]);
      await expect.poll(() => statusesOf(b.Dee.id), poll).toEqual(["complete"]);
      const [first] = await client.assignments.list({ botId: b.Cid.id });
      cid.push(titled("Dee", "elsewhere"), quiet);

      await client.assignments.cancel({ botId: b.Cid.id, assignmentId: first!.id });

      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Dee.id })).at(-1)!.title, poll)
        .toBe("elsewhere");
      const elsewhere = (await client.assignments.list({ botId: b.Dee.id })).at(-1)!;
      expect(elsewhere.parent).toBeNull();
      const [parent] = await client.assignments.list({ botId: b.Bea.id });
      expect(parent!.children.map((child) => child.title)).toEqual(["first", "second"]);
    },
    timeout,
  );

  it(
    "goes by the chain a Turn is on, so naming a shallow parent doesn't get past the limit",
    async () => {
      const dee: Round[] = [quiet];
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [titled("Bea", "one"), quiet],
        Bea: [titled("Cid", "two"), quiet],
        Cid: [titled("Dee", "three"), quiet],
        Dee: dee,
        Eve: [titled("Dee", "shallow"), quiet],
      });
      await tell("Eve", "Hand it on.");
      await expect.poll(() => statusesOf(b.Dee.id), poll).toEqual(["complete"]);
      const [shallow] = await client.assignments.list({ botId: b.Dee.id });
      dee.push(titled("Eve", "dodge", shallow!.id), quiet);

      await tell("Ann", "Start it.");

      await expect.poll(() => answersIn(fakes.Dee), poll).toMatch(/stops at 3 deep/);
      expect(await client.assignments.list({ botId: b.Eve.id })).toEqual([]);
    },
    timeout,
  );

  it(
    "treats a Check-in's Turn as work on the Bot's open Assignment, and a user's Message as new work",
    async () => {
      const bea: Round[] = [quiet];
      const {
        deps,
        client,
        bots: b,
        tell,
      } = await bots({
        Ann: [titled("Bea", "parent"), quiet],
        Bea: bea,
        Cid: [quiet, quiet],
      });
      await tell("Ann", "Hand it on.");
      await expect.poll(() => statusesOf(b.Bea.id), poll).toEqual(["complete"]);
      const [parent] = await client.assignments.list({ botId: b.Bea.id });
      bea.push(titled("Cid", "from the Check-in"), quiet);

      const conversationId = await conversationOf(b.Bea.id);
      await getTestDb().transaction((tx) =>
        receive(deps, tx, {
          id: `check_in:${uuidv7()}`,
          botId: b.Bea.id,
          conversationId,
          source: "check_in",
          channel: "schedule",
          text: "Come back to the draft.",
          receivedAt: deps.clock(),
        }),
      );
      deps.runner.wake();

      await expect.poll(() => statusOf(client, b.Bea.id), poll).toBe("blocked");
      const [child] = await client.assignments.list({ botId: b.Cid.id });
      expect(child!.parent!.id).toBe(parent!.id);

      await expect.poll(() => statusesOf(b.Bea.id), poll).toEqual(["complete", "complete"]);
      bea.push(titled("Cid", "from the user"), quiet);
      await tell("Bea", "Ask Cid something else.");

      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Cid.id })).at(-1)!.title, poll)
        .toBe("from the user");
      expect((await client.assignments.list({ botId: b.Cid.id })).at(-1)!.parent).toBeNull();
    },
    timeout,
  );

  /** Ann hands Bea work; Bea splits one child off to Cid, which ends, and one to Dee, which splits one off to Eve. */
  async function split() {
    const rounds = {
      Ann: [titled("Bea", "parent"), quiet] as Round[],
      Bea: [
        round(
          runs("assign_work", { bot: "Cid", title: "ended", instructions: "One." }),
          runs("assign_work", { bot: "Dee", title: "running", instructions: "Two." }),
        ),
        quiet,
        quiet,
      ] as Round[],
      Cid: [finish({ status: "done", outcome: "Kept." }), quiet],
      Dee: [titled("Eve", "deepest"), quiet, quiet],
      Eve: [quiet, quiet],
    };
    const made = await bots(rounds);
    await made.tell("Ann", "Hand it on.");
    await expect.poll(() => statusesOf(made.bots.Bea.id), poll).toEqual(["complete", "complete"]);
    await expect.poll(() => statusesOf(made.bots.Eve.id), poll).toEqual(["complete"]);
    await expect.poll(() => statusesOf(made.bots.Dee.id), poll).toEqual(["complete"]);
    const [parent] = await made.client.assignments.list({ botId: made.bots.Bea.id });
    expect(parent!.status).toBe("blocked");
    return { ...made, rounds, parent: parent! };
  }

  /** Dee's and Eve's were cancelled with a log row each, and Cid's keeps its result. */
  async function expectCascaded(
    { client, bots: b, fakes }: Awaited<ReturnType<typeof split>>,
    by: string,
  ) {
    await expect.poll(() => statusesOf(b.Eve.id), poll).toEqual(["complete", "complete"]);
    await expect.poll(() => statusesOf(b.Dee.id), poll).toEqual(["complete", "complete"]);
    for (const botId of [b.Dee.id, b.Eve.id]) {
      const [row] = await client.assignments.list({ botId });
      expect(row).toMatchObject({ status: "cancelled", result: null });
      expect(row!.log.filter((entry) => entry.status === "cancelled")).toEqual([
        expect.objectContaining({ actor: "system", note: expect.stringMatching(/part of/) }),
      ]);
    }
    expect(JSON.stringify(fakes.Eve.calls.at(-1)!.messages.slice(1))).toContain(
      `was cancelled by ${by}`,
    );
    const [ended] = await client.assignments.list({ botId: b.Cid.id });
    expect(ended).toMatchObject({ status: "done", result: { outcome: "Kept." } });
    expect(changesIn(ended!.log).map((entry) => entry.status)).toEqual(["open", "working", "done"]);
  }

  it(
    "cancels its open children when the owner cancels a parent, each with a log row",
    async () => {
      const made = await split();
      // Bea hears of its own cancel, and Ann, which waits on it.
      made.rounds.Ann.push(quiet);
      made.rounds.Bea.push(quiet);

      await made.client.assignments.cancel({
        botId: made.bots.Bea.id,
        assignmentId: made.parent.id,
      });

      await expectCascaded(made, "the user");
      expect(await statusOf(made.client, made.bots.Bea.id)).toBe("cancelled");
    },
    timeout,
  );

  it(
    "cancels its open children when the Bot that started a parent cancels it",
    async () => {
      const made = await split();
      made.rounds.Ann.push(round(runs("cancel_assignment", { id: made.parent.id })), quiet);
      made.rounds.Bea.push(quiet);

      await made.tell("Ann", "Drop it.");

      await expectCascaded(made, "Ann");
      expect(await statusOf(made.client, made.bots.Bea.id)).toBe("cancelled");
    },
    timeout,
  );

  it(
    "lets a parent with open children be finished by its Bot, which cancels those children",
    async () => {
      const made = await split();
      made.rounds.Ann.push(quiet);
      made.rounds.Bea.push(
        round(
          runs("finish_assignment", { id: made.parent.id, status: "done", outcome: "Enough." }),
        ),
        quiet,
      );

      await made.tell("Bea", "That's enough, finish it.");

      await expectCascaded(made, "Bea");
      const [finished] = await made.client.assignments.list({ botId: made.bots.Bea.id });
      expect(finished).toMatchObject({ status: "done", result: { outcome: "Enough." } });
      // Ann hears the result.
      await expect.poll(() => statusesOf(made.bots.Ann.id), poll).toHaveLength(2);
    },
    timeout,
  );

  it(
    "gives a Bot its blocked Assignment again after a reset, without waking it for one",
    async () => {
      const made = await split();
      await made.client.bots.reset({ botId: made.bots.Bea.id, name: "Bea" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await statusesOf(made.bots.Bea.id)).toEqual(["complete", "complete"]);

      made.rounds.Bea.push(quiet);
      await made.tell("Bea", "Where were we?");

      await expect.poll(() => statusesOf(made.bots.Bea.id), poll).toHaveLength(3);
      await expect.poll(() => made.fakes.Bea.calls.length, poll).toBe(4);
      expect(JSON.stringify(made.fakes.Bea.calls.at(-1)!.messages.slice(1))).toContain(
        `Assignment ${made.parent.id} from Ann`,
      );
      expect(await statusOf(made.client, made.bots.Bea.id)).toBe("blocked");
    },
    timeout,
  );

  it(
    "tells a paused child's Bot of the cascade when it resumes",
    async () => {
      const made = await split();
      made.rounds.Ann.push(quiet);
      made.rounds.Bea.push(quiet);
      await made.client.bots.pause({ botId: made.bots.Eve.id });

      await made.client.assignments.cancel({
        botId: made.bots.Bea.id,
        assignmentId: made.parent.id,
      });
      await expect.poll(() => statusOf(made.client, made.bots.Eve.id), poll).toBe("cancelled");
      expect(await statusesOf(made.bots.Eve.id)).toEqual(["complete"]);

      await made.client.bots.resume({ botId: made.bots.Eve.id });

      await expect.poll(() => statusesOf(made.bots.Eve.id), poll).toEqual(["complete", "complete"]);
      expect(JSON.stringify(made.fakes.Eve.calls.at(-1)!.messages.slice(1))).toContain(
        "was cancelled",
      );
    },
    timeout,
  );

  it(
    "shows a Bot the link when it reads, and exports it with the user's data",
    async () => {
      const made = await split();
      made.rounds.Bea.push(round(runs("read_assignment", { id: made.parent.id })), quiet);

      await made.tell("Bea", "How does it stand?");

      await expect.poll(() => answersIn(made.fakes.Bea), poll).toMatch(/assignedTo.*Dee/);
      expect(answersIn(made.fakes.Bea)).toMatch(/ended.*running/);
      // Only what each Bot is part of: the Bot that started the parent didn't start its children.
      made.rounds.Ann.push(round(runs("read_assignment", { id: made.parent.id })), quiet);
      await made.tell("Ann", "How does it stand?");
      await expect.poll(() => answersIn(made.fakes.Ann), poll).toMatch(/instructions/);
      expect(answersIn(made.fakes.Ann)).not.toMatch(/children/);
      const [running] = await made.client.assignments.list({ botId: made.bots.Dee.id });
      made.rounds.Dee.splice(2, 1, round(runs("read_assignment", { id: running!.id })), quiet);
      await made.tell("Dee", "How does it stand?");
      await expect.poll(() => answersIn(made.fakes.Dee), poll).toMatch(/instructions/);
      expect(JSON.stringify(toolResultsIn(made.fakes.Dee.calls.at(-1)).at(-1))).not.toMatch(
        /parent/,
      );

      const data = await exportUserData(made.deps, made.user.id);
      expect(JSON.stringify(data.bot)).toContain(`"parentAssignmentId":"${made.parent.id}"`);
    },
    timeout,
  );
});

describe("an Assignment's budget (#1184)", () => {
  /** A Step that does nothing but go on to another. */
  const busy = (count: number) =>
    Array.from({ length: count }, () => round(runs("read_assignment", {})));

  /** What the Model is told a call used, so it costs $0.30 on `hostModel`. */
  const costly = (played: Round) =>
    withUsage(played as Parameters<typeof withUsage>[0], {
      promptTokens: 100_000,
      completionTokens: 0,
      totalTokens: 100_000,
    });

  const assignmentOf = async (
    client: Awaited<ReturnType<typeof bots>>["client"],
    botId: string,
    index = 0,
  ) => (await client.assignments.list({ botId }))[index]!;

  /** Wakes a Bot afresh on its open Assignments, with nothing else in the Turn. */
  const rewake = async (client: Awaited<ReturnType<typeof bots>>["client"], botId: string) => {
    await client.bots.pause({ botId });
    await client.bots.resume({ botId });
  };

  /**
   * Scout hands Writer the work while Writer is paused, the limits are set, and Writer is resumed,
   * so its first Turn already works to them.
   */
  async function limited<N extends string>(
    rounds: Record<N | "Scout" | "Writer", Round[]>,
    limits: { callLimit?: number; moneyLimitMicros?: number },
    options: Parameters<typeof bots>[1] = {},
  ) {
    const made = await bots(rounds as Record<string, Round[]>, options);
    const writer = made.bots.Writer!;
    await made.client.bots.pause({ botId: writer.id });
    await made.tell("Scout", "Hand it on.");
    await expect.poll(() => statusesOf(made.bots.Scout!.id), poll).toEqual(["complete"]);
    const { id } = await assignmentOf(made.client, writer.id);
    await getTestDb().update(botAssignment).set(limits).where(eq(botAssignment.id, id));
    return { ...made, id, resume: () => made.client.bots.resume({ botId: writer.id }) };
  }

  it(
    "stops at 30 model calls on the user's own key, where cost is $0, and asks the owner",
    async () => {
      const {
        fakes,
        client,
        bots: b,
      } = await bots({ Scout: [assign("Writer"), quiet], Writer: busy(45) });
      await client.bots.send({ botId: b.Scout.id, id: uuidv7(), text: "Hand it on." });
      // A Turn stops at 10 Steps, so three Turns reach the limit.
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["error"]);
      expect((await assignmentOf(client, b.Writer.id)).budget).toEqual({
        calls: 10,
        callLimit: 30,
        costMicros: 0,
        moneyLimitMicros: 1_000_000,
        overBudget: false,
      });
      await rewake(client, b.Writer.id);
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["error", "error"]);
      await rewake(client, b.Writer.id);
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["error", "error", "error"]);
      expect(fakes.Writer.calls).toHaveLength(30);
      await rewake(client, b.Writer.id);
      await expect
        .poll(() => statusesOf(b.Writer.id), poll)
        .toEqual(["error", "error", "error", "complete"]);

      // The next call never started.
      expect(fakes.Writer.calls).toHaveLength(30);
      const row = await assignmentOf(client, b.Writer.id);
      expect(row.status).toBe("blocked");
      expect(row.budget).toMatchObject({ calls: 30, costMicros: 0, overBudget: true });

      // The log shows the spend, a Turn to a row, and the block.
      expect(row.log.flatMap((entry) => (entry.calls ? [entry.calls] : []))).toEqual([10, 10, 10]);
      const last = row.log.at(-1)!;
      expect(last).toMatchObject({ status: "blocked", actor: "system" });
      expect(last.note).toContain("30 of 30 model calls");

      // The owner is asked, in the Bot's Conversation.
      const { messages } = await client.bots.get({ botId: b.Writer.id });
      expect(messages.at(-1)!.text).toContain("Draft the post");
      expect(messages.at(-1)!.text).toContain("Raise its limit or cancel it");
    },
    timeout,
  );

  it(
    "stops at $1 on Host credentials, letting the call already started finish, and counts against the Quota as usage",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        deps,
        user,
      } = await bots(
        {
          Scout: [assign("Writer"), quiet],
          Writer: busy(9).map((played) => costly(played)),
        },
        { hostProviders },
      );
      await client.bots.pause({ botId: b.Writer.id });
      await getTestDb().update(bot).set({ model: hostModel }).where(eq(bot.id, b.Writer.id));
      await client.bots.send({ botId: b.Scout.id, id: uuidv7(), text: "Hand it on." });
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);
      await client.bots.resume({ botId: b.Writer.id });
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

      // Three calls leave $0.90; the fourth starts under $1 and finishes over it.
      expect(fakes.Writer.calls).toHaveLength(4);
      const row = await assignmentOf(client, b.Writer.id);
      expect(row.status).toBe("blocked");
      expect(row.budget).toMatchObject({ calls: 4, costMicros: 1_200_000, overBudget: true });
      expect(row.log.at(-1)!.note).toContain("$1.20 of $1.00");
      expect(row.log.find((entry) => entry.calls)).toMatchObject({
        calls: 4,
        costMicros: 1_200_000,
      });

      // Normal usage: the same money in the owner's own rows.
      const rows = await deps.db.select().from(usage).where(eq(usage.userId, user.id));
      expect(
        rows.filter((entry) => entry.kind === "turn" && entry.model === hostModel),
      ).toHaveLength(4);
      expect(
        rows
          .filter((entry) => entry.model === hostModel)
          .reduce((sum, entry) => sum + entry.costMicros, 0),
      ).toBe(1_200_000);
    },
    timeout,
  );

  it(
    "has a child draw from its parent's budget, so splitting can't escape the limit",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        id,
        resume,
      } = await limited(
        {
          Scout: [assign("Writer"), quiet],
          Writer: [assign("Editor", "Check the facts"), quiet],
          Editor: busy(9),
        } as Record<"Scout" | "Writer" | "Editor", Round[]>,
        { callLimit: 6 },
      );
      await resume();

      // Writer's two calls and Editor's four make six.
      await expect.poll(() => statusesOf(b.Editor!.id), poll).toEqual(["complete"]);
      expect(fakes.Editor!.calls).toHaveLength(4);
      const child = await assignmentOf(client, b.Editor!.id);
      expect(child.status).toBe("blocked");
      expect(child.budget).toMatchObject({ calls: 6, callLimit: 6, overBudget: true });
      const parent = await assignmentOf(client, b.Writer!.id);
      expect(parent.id).toBe(id);
      expect(parent.budget).toMatchObject({ calls: 6, callLimit: 6 });
      // A child's spend shows in its own log.
      expect(child.log.find((entry) => entry.calls)?.calls).toBe(4);
    },
    timeout,
  );

  /** A `finish_assignment` call on the Assignment the newest Trigger names. */
  const finishNewest = (call: TextOptions) => {
    const ids = [
      ...JSON.stringify(call.messages.slice(1)).matchAll(/Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/g),
    ];
    return round(
      runs("finish_assignment", { id: ids.at(-1)![1]!, status: "done", outcome: "Done." }),
    );
  };

  it(
    "stops a loop of children one after another under one parent, which the chain limit never reaches",
    async () => {
      const rounds = (count: number, step: Round) =>
        Array.from({ length: count }, () => [step, quiet]).flat();
      const {
        fakes,
        client,
        bots: b,
        resume,
      } = await limited(
        {
          Scout: [assign("Writer"), quiet],
          Writer: rounds(8, assign("Editor", "One more part")),
          Editor: rounds(8, finishNewest),
        } as Record<"Scout" | "Writer" | "Editor", Round[]>,
        { callLimit: 9 },
      );
      await resume();

      await expect
        .poll(async () => (await assignmentOf(client, b.Writer!.id)).budget.overBudget, poll)
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fakes.Writer!.calls.length + fakes.Editor!.calls.length).toBe(9);
      expect(await client.assignments.list({ botId: b.Editor!.id })).toHaveLength(3);
    },
    timeout,
  );

  it(
    "keeps a parent over budget blocked when its last open child ends",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        resume,
      } = await limited(
        {
          Scout: [assign("Writer"), quiet],
          Writer: [
            round(
              runs("assign_work", { bot: "Editor", title: "One", instructions: "Do it." }),
              runs("assign_work", { bot: "Checker", title: "Two", instructions: "Do it." }),
            ),
            quiet,
            ...busy(5),
          ],
          Editor: busy(3),
          Checker: busy(3),
        } as Record<"Scout" | "Writer" | "Editor" | "Checker", Round[]>,
        { callLimit: 2 },
      );
      await resume();

      // Both children start over budget, and neither makes a call.
      await expect
        .poll(async () => (await assignmentOf(client, b.Checker!.id)).budget.overBudget, poll)
        .toBe(true);
      await expect
        .poll(async () => (await assignmentOf(client, b.Editor!.id)).budget.overBudget, poll)
        .toBe(true);
      expect(fakes.Editor!.calls).toHaveLength(0);

      // Cancelling one wakes the parent's Bot, whose Turn finds the parent over budget.
      const one = await assignmentOf(client, b.Editor!.id);
      await client.assignments.cancel({ botId: b.Editor!.id, assignmentId: one.id });
      await expect.poll(() => statusesOf(b.Writer!.id), poll).toEqual(["complete", "complete"]);
      const blockedParent = await assignmentOf(client, b.Writer!.id);
      expect(blockedParent).toMatchObject({ status: "blocked" });
      expect(fakes.Writer!.calls).toHaveLength(2);

      // The last child ending doesn't clear it.
      const two = await assignmentOf(client, b.Checker!.id);
      await client.assignments.cancel({ botId: b.Checker!.id, assignmentId: two.id });
      await expect
        .poll(() => statusesOf(b.Writer!.id), poll)
        .toEqual(["complete", "complete", "complete"]);
      expect((await assignmentOf(client, b.Writer!.id)).status).toBe("blocked");
      expect(fakes.Writer!.calls).toHaveLength(2);
    },
    timeout,
  );

  /** Scout hands Writer two Assignments while it's paused, so one Turn takes both. */
  async function twoInOneTurn(writer: Round[]) {
    const made = await bots({
      Scout: [
        round(
          runs("assign_work", { bot: "Writer", title: "First", instructions: "Do it." }),
          runs("assign_work", { bot: "Writer", title: "Second", instructions: "Do it." }),
        ),
        quiet,
      ],
      Writer: writer,
    });
    await made.client.bots.pause({ botId: made.bots.Writer.id });
    await made.tell("Scout", "Hand them on.");
    await expect.poll(() => statusesOf(made.bots.Scout.id), poll).toEqual(["complete"]);
    const [first, second] = await made.client.assignments.list({ botId: made.bots.Writer.id });
    return { ...made, first: first!, second: second! };
  }

  it(
    "counts a Turn that took two Assignments against each",
    async () => {
      const { client, bots: b } = await twoInOneTurn([quiet]);
      await client.bots.resume({ botId: b.Writer.id });
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const [first, second] = await client.assignments.list({ botId: b.Writer.id });
      expect(first!.budget.calls).toBe(1);
      expect(second!.budget.calls).toBe(1);
    },
    timeout,
  );

  it(
    "stops a shared Turn when one Assignment goes over, and wakes the Bot afresh on the other",
    async () => {
      const { fakes, client, bots: b, first, second } = await twoInOneTurn([quiet, quiet]);
      await getTestDb()
        .update(botAssignment)
        .set({ callLimit: 0 })
        .where(eq(botAssignment.id, first.id));
      await client.bots.resume({ botId: b.Writer.id });

      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
      const [over, other] = await client.assignments.list({ botId: b.Writer.id });
      expect(over).toMatchObject({ id: first.id, status: "blocked" });
      expect(other).toMatchObject({ id: second.id, status: "working" });
      // Only the second Turn called the Model, and it's on the other alone.
      expect(fakes.Writer.calls).toHaveLength(1);
      expect(other!.budget.calls).toBe(1);
      expect(over!.budget.calls).toBe(0);
    },
    timeout,
  );

  /** Fires a Check-in's Trigger at the Bot, as a due Check-in does. */
  const checkIn = async (deps: TestDeps, botId: string) => {
    const [row] = await getTestDb()
      .select({ conversationId: bot.conversationId })
      .from(bot)
      .where(eq(bot.id, botId));
    await getTestDb().transaction((tx) =>
      receive(deps, tx, {
        id: `check_in:${uuidv7()}`,
        botId,
        conversationId: row!.conversationId,
        source: "check_in",
        channel: "schedule",
        text: "Come back to it.",
        receivedAt: deps.clock(),
      }),
    );
    deps.runner.wake();
  };

  it(
    "stops a Check-in's Turn at the limit, and the next, so setting Check-ins can't work past it",
    async () => {
      const made = await limited(
        { Scout: [assign("Writer"), quiet], Writer: [quiet, ...busy(5)] },
        { callLimit: 1 },
      );
      const writer = made.bots.Writer!;
      await made.resume();
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete"]);

      await checkIn(made.deps, writer.id);
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete", "complete"]);
      expect((await assignmentOf(made.client, writer.id)).status).toBe("blocked");
      expect(made.fakes.Writer!.calls).toHaveLength(1);

      await checkIn(made.deps, writer.id);
      await expect
        .poll(() => statusesOf(writer.id), poll)
        .toEqual(["complete", "complete", "complete"]);
      expect(made.fakes.Writer!.calls).toHaveLength(1);
    },
    timeout,
  );

  it(
    "keeps what a Check-in's Turn recorded when a Stop attaches the user's waiting Message to it",
    async () => {
      const step = round(runs("read_assignment", {}));
      const {
        fakes,
        client,
        bots: b,
        deps,
        tell,
      } = await bots(
        { Scout: [assign("Writer"), quiet], Writer: [quiet, step, step] },
        { manual: ["Writer"] },
      );
      await tell("Scout", "Hand it on.");
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(1);
      await fakes.Writer.release(quiet.length);
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

      await checkIn(deps, b.Writer.id);
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(2);
      await fakes.Writer.release(step.length);
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(3);

      await tell("Writer", "Are you there?").catch(() => {});
      await client.bots.stop({ botId: b.Writer.id });
      await expect
        .poll(async () => (await turnsOf(b.Writer.id))[1]?.status, poll)
        .not.toBe("running");
      expect((await turnsOf(b.Writer.id))[1]!.usage).not.toBeNull();

      // Its job recorded budget Checkpoints, so a replay after the attempt died must still ask for
      // them, with the Message attached: it is the only seam, as a live attempt never replays here.
      const turn = (await turnsOf(b.Writer.id))[1]!;
      const taken = await getTestDb()
        .select({ source: botTrigger.source })
        .from(botTrigger)
        .where(eq(botTrigger.turnId, turn.id));
      expect(taken.map((row) => row.source)).toContain("user");
      const replay = { patched: async () => true } as unknown as WorkflowContext<Transaction>;
      expect(await turnBudget(deps, turn, replay, getTestDb())).toBeDefined();
    },
    timeout,
  );

  it(
    "leaves a Check-in's Turn alone on a Bot with no Assignment",
    async () => {
      const { fakes, bots: b, deps } = await bots({ Solo: [quiet], Other: [] });
      await checkIn(deps, b.Solo.id);
      await expect.poll(() => statusesOf(b.Solo.id), poll).toEqual(["complete"]);
      expect(fakes.Solo.calls).toHaveLength(1);
    },
    timeout,
  );

  it(
    "stops a Bot's Steps after it finished a child that spent the last of the parent's budget",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        resume,
      } = await limited(
        {
          Scout: [assign("Writer"), quiet],
          Writer: [assign("Editor", "Check the facts"), quiet, quiet],
          Editor: [finish({ status: "done", outcome: "Done." }), ...busy(5)],
        } as Record<"Scout" | "Writer" | "Editor", Round[]>,
        { callLimit: 3 },
      );
      await resume();
      await expect.poll(() => statusesOf(b.Editor!.id), poll).toEqual(["complete"]);
      expect(fakes.Editor!.calls).toHaveLength(1);
      await expect
        .poll(async () => (await assignmentOf(client, b.Writer!.id)).budget.overBudget, poll)
        .toBe(true);
    },
    timeout,
  );

  it(
    "charges a Step after a child ended to the parent's budget, on the parent's log",
    async () => {
      const {
        client,
        bots: b,
        resume,
      } = await limited(
        {
          Scout: [assign("Writer"), quiet],
          Writer: [assign("Editor", "Check the facts"), quiet, quiet],
          Editor: [finish({ status: "done", outcome: "Done." }), quiet],
        } as Record<"Scout" | "Writer" | "Editor", Round[]>,
        { callLimit: 20 },
      );
      await resume();
      await expect.poll(() => statusesOf(b.Editor!.id), poll).toEqual(["complete"]);
      await expect.poll(() => statusesOf(b.Writer!.id), poll).toEqual(["complete", "complete"]);
      const child = await assignmentOf(client, b.Editor!.id);
      // Its finish cost one call; the Step after isn't on its log. Writer's three make five.
      expect(child.log.filter((entry) => entry.calls).map((entry) => entry.calls)).toEqual([1]);
      expect(child.budget.calls).toBe(5);
    },
    timeout,
  );

  it(
    "raises a limit past a sibling whose Bot can't run while that sibling still waits on a child",
    async () => {
      const made = await limited(
        { Scout: [assign("Writer"), quiet], Writer: [quiet, ...busy(3)] },
        { callLimit: 1 },
      );
      await made.resume();
      const writer = made.bots.Writer!;
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete"]);
      await rewake(made.client, writer.id);
      await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete", "complete"]);
      const [child] = await getTestDb()
        .insert(botAssignment)
        .values({
          id: uuidv7(),
          assignedBotId: made.bots.Scout!.id,
          assignerBotId: writer.id,
          parentAssignmentId: made.id,
          title: "Waiting",
          instructions: "Do it.",
          status: "working",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: botAssignment.id });
      await getTestDb().update(bot).set({ model: hostModel }).where(eq(bot.id, writer.id));
      await made.client.assignments.raiseLimit({
        botId: writer.id,
        assignmentId: made.id,
        callLimit: 5,
      });
      expect(await assignmentOf(made.client, writer.id)).toMatchObject({
        status: "blocked",
        budget: { callLimit: 5, overBudget: false },
      });
      expect(child).toBeDefined();
    },
    timeout,
  );

  /** Writer has used up a limit of one call, and is blocked. */
  async function overBudget() {
    const made = await limited(
      { Scout: [assign("Writer"), quiet], Writer: [quiet, quiet, quiet] },
      { callLimit: 1 },
    );
    await made.resume();
    const writer = made.bots.Writer!;
    await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete"]);
    await rewake(made.client, writer.id);
    await expect.poll(() => statusesOf(writer.id), poll).toEqual(["complete", "complete"]);
    expect((await assignmentOf(made.client, writer.id)).status).toBe("blocked");
    return { ...made, writer };
  }

  it(
    "resumes the work when the owner raises the limit",
    async () => {
      const { fakes, client, writer, id } = await overBudget();
      expect(fakes.Writer!.calls).toHaveLength(1);

      await client.assignments.raiseLimit({ botId: writer.id, assignmentId: id, callLimit: 2 });

      await expect
        .poll(() => statusesOf(writer.id), poll)
        .toEqual(["complete", "complete", "complete"]);
      expect(fakes.Writer!.calls).toHaveLength(2);
      const row = await assignmentOf(client, writer.id);
      expect(row.status).toBe("working");
      expect(row.budget).toMatchObject({ calls: 2, callLimit: 2, overBudget: false });
      expect(row.log.at(-1)!.actor).toBe("system");
      const raised = row.log.find((entry) => entry.actor === "user")!;
      expect(raised).toMatchObject({ status: "working" });
      expect(raised.note).toContain("2 model calls");
    },
    timeout,
  );

  it(
    "keeps it blocked when the raise leaves the other limit spent",
    async () => {
      const { client, writer, id } = await overBudget();
      await client.assignments.raiseLimit({
        botId: writer.id,
        assignmentId: id,
        moneyLimitUsd: 5,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await statusesOf(writer.id)).toHaveLength(2);
      expect(await assignmentOf(client, writer.id)).toMatchObject({
        status: "blocked",
        budget: { moneyLimitMicros: 5_000_000, overBudget: true },
      });
    },
    timeout,
  );

  it(
    "refuses a raise that lowers a limit, one of another user's Assignment, and one that ended",
    async () => {
      const { client, writer, id, deps } = await overBudget();
      await expect(
        client.assignments.raiseLimit({ botId: writer.id, assignmentId: id, callLimit: 1 }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        client.assignments.raiseLimit({ botId: writer.id, assignmentId: id }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      const stranger = chatRpc({ user: await insertUser(), deps });
      await expect(
        stranger.assignments.raiseLimit({ botId: writer.id, assignmentId: id, callLimit: 9 }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await client.assignments.cancel({ botId: writer.id, assignmentId: id });
      await expect(
        client.assignments.raiseLimit({ botId: writer.id, assignmentId: id, callLimit: 9 }),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "error.assignmentEnded" } });
    },
    timeout,
  );

  it(
    "lets the owner cancel one over budget, and a resume or reset doesn't wake it",
    async () => {
      const { fakes, client, writer, id } = await overBudget();
      await rewake(client, writer.id);
      await client.bots.reset({ botId: writer.id, name: "Writer" });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(fakes.Writer!.calls).toHaveLength(1);
      expect(await assignmentOf(client, writer.id)).toMatchObject({
        status: "blocked",
        budget: { overBudget: true },
      });

      await client.assignments.cancel({ botId: writer.id, assignmentId: id });
      expect((await assignmentOf(client, writer.id)).status).toBe("cancelled");
    },
    timeout,
  );

  it(
    "tells a Bot reading an Assignment what has been spent",
    async () => {
      const {
        fakes,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet],
        Writer: [
          (call: TextOptions) => round(runs("read_assignment", { id: assignmentIdIn(call) })),
          quiet,
        ],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const answer = JSON.stringify(toolResultsIn(fakes.Writer.calls.at(-1)));
      expect(answer).toContain("modelCallLimit");
      expect(answer).toContain("modelCalls");
    },
    timeout,
  );

  it(
    "refuses a raise when the Bot can't run to resume, and keeps the limit",
    async () => {
      const { client, writer, id } = await overBudget();
      await getTestDb().update(bot).set({ model: hostModel }).where(eq(bot.id, writer.id));
      await expect(
        client.assignments.raiseLimit({ botId: writer.id, assignmentId: id, callLimit: 9 }),
      ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "error.assignmentCantResume" } });
      expect((await assignmentOf(client, writer.id)).budget.callLimit).toBe(1);
    },
    timeout,
  );

  it(
    "takes a user's Message in a Turn beside an Assignment that goes over: the Turn carries on, told so",
    async () => {
      const made = await limited(
        { Scout: [assign("Writer"), quiet], Writer: [says("Hello."), quiet] },
        { callLimit: 0 },
      );
      const writer = made.bots.Writer!;
      await made.resume();
      await made.client.bots.send({ botId: writer.id, id: uuidv7(), text: "Hi?" });
      await expect.poll(async () => (await statusesOf(writer.id)).at(-1), poll).toBe("complete");
      // One Turn took both, and its Model was told the Assignment is out of its hands.
      expect(await turnsOf(writer.id)).toHaveLength(1);
      expect(JSON.stringify(made.fakes.Writer!.calls[0]!.messages)).toContain("out of budget");
      const { messages } = await made.client.bots.get({ botId: writer.id });
      expect(messages.map((message) => message.text)).toContain("Hello.");
      expect((await assignmentOf(made.client, writer.id)).status).toBe("blocked");
    },
    timeout,
  );

  it(
    "leaves a Turn with no Assignment exactly as it was: no limit, no spend, and its Step limit its own",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
        deps,
        user,
      } = await bots({
        Solo: busy(15),
        Other: [],
      });
      await tell("Solo", "Keep going.");
      await expect.poll(() => statusesOf(b.Solo.id), poll).toEqual(["error"]);
      const [turn] = await turnsOf(b.Solo.id);
      expect(turn!.error).toBe("step_limit");
      expect(fakes.Solo.calls).toHaveLength(10);
      expect(await client.assignments.list({ botId: b.Solo.id })).toEqual([]);
      const rows = await deps.db.select().from(usage).where(eq(usage.userId, user.id));
      expect(rows.filter((row) => row.sourceId === turn!.id)).toHaveLength(10);
      // Its job recorded no budget Checkpoint.
      const history = await loadHistory(getTestDb(), turn!.jobId!);
      expect(history.map((entry) => entry.name)).not.toContain("assignment_budget");
    },
    timeout,
  );

  it(
    "keeps the budget and spend in the export",
    async () => {
      const { deps, user, writer } = await overBudget();
      const exported = (await exportUserData(deps, user.id)).bot as {
        assignments: {
          assignedBotId: string;
          callLimit: number;
          callsSpent: number;
          log: { calls: number | null }[];
        }[];
      };
      const row = exported.assignments.find((entry) => entry.assignedBotId === writer.id)!;
      expect(row).toMatchObject({ callLimit: 1, callsSpent: 1 });
      expect(row.log.some((entry) => entry.calls === 1)).toBe(true);
    },
    timeout,
  );
});

describe("the branch review of spec #1166", () => {
  const saysNothing = quiet;

  /** Bot `botId` wakes on a Trigger from `source`, with no user asking. */
  const wakeFrom = async (deps: TestDeps, botId: string, source: "helper" | "approval") => {
    const conversationId = await conversationOf(botId);
    await getTestDb().transaction((tx) =>
      receive(deps, tx, {
        id: `${source}:${uuidv7()}`,
        botId,
        conversationId,
        source,
        channel: source,
        text: "Your Helper reported: it's ready.",
        receivedAt: deps.clock(),
      }),
    );
    deps.runner.wake();
  };

  /** How many of `calls` hold `text`, each counted once. */
  const callsWith = (calls: TextOptions[], text: string) =>
    calls.filter((call) => JSON.stringify(call.messages).includes(text)).length;

  /** How many times the newest of `calls` says `text`. */
  const timesInLast = (calls: TextOptions[], text: string) =>
    JSON.stringify(calls.at(-1)!.messages).split(text).length - 1;

  describe.each(["helper", "approval"] as const)("a Turn woken by a %s Trigger", (source) => {
    it(
      "counts as work on the Bot's open Assignment, so its chain and its budget hold",
      async () => {
        const writer: Round[] = [quiet];
        const {
          deps,
          client,
          bots: b,
          tell,
        } = await bots({
          Scout: [assign("Writer"), quiet],
          Writer: writer,
          Editor: [quiet],
        });
        await tell("Scout", "Hand it on.");
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
        const [parent] = await client.assignments.list({ botId: b.Writer.id });
        const before = parent!.budget.calls;
        writer.push(assign("Editor", "From the report"), quiet);

        await wakeFrom(deps, b.Writer.id, source);

        await expect
          .poll(async () => (await client.assignments.list({ botId: b.Editor.id })).length, poll)
          .toBe(1);
        const [child] = await client.assignments.list({ botId: b.Editor.id });
        expect(child!.parent?.id).toBe(parent!.id);
        await expect
          .poll(
            async () => (await client.assignments.list({ botId: b.Writer.id }))[0]!.budget.calls,
            poll,
          )
          .toBeGreaterThan(before);
      },
      timeout,
    );
  });

  it(
    "leaves a Helper's report in a Room off the Bot's open Assignments",
    async () => {
      const writer: Round[] = [quiet];
      const {
        deps,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet],
        Writer: writer,
        Editor: [quiet],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const room = await client.rooms.create({ name: "Launch", botIds: [b.Writer.id, b.Scout.id] });
      writer.push(assign("Editor", "From the Room"), quiet);

      await getTestDb().transaction((tx) =>
        receive(deps, tx, {
          id: `helper:${uuidv7()}`,
          botId: b.Writer.id,
          conversationId: room.conversationId,
          source: "helper",
          channel: "helper",
          text: "Your Helper reported: it's ready.",
          receivedAt: deps.clock(),
        }),
      );
      deps.runner.wake();

      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Editor.id })).length, poll)
        .toBe(1);
      const [child] = await client.assignments.list({ botId: b.Editor.id });
      expect(child!.parent).toBeNull();
    },
    timeout,
  );

  it(
    "gives the Bot a result batched with an Assignment that's out of budget",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Boss: [assign("Editor", "Side job"), quiet, quiet, quiet],
        Editor: [finish({ status: "done", outcome: "Side job finished." }), quiet],
        Scout: [assign("Boss", "Over budget"), quiet],
      });
      await tell("Boss", "Start the side job.");
      await expect.poll(() => statusesOf(b.Boss.id), poll).toEqual(["complete"]);
      await client.bots.pause({ botId: b.Boss.id });
      await expect.poll(() => statusesOf(b.Editor.id), poll).toContain("complete");
      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Editor.id }))[0]!.status, poll)
        .toBe("done");
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);
      const [over] = await client.assignments.list({ botId: b.Boss.id });
      await getTestDb()
        .update(botAssignment)
        .set({ callLimit: 1, callsSpent: 1 })
        .where(eq(botAssignment.id, over!.id));

      // The wake's two Triggers join one Turn.
      await client.bots.resume({ botId: b.Boss.id });

      await expect
        .poll(() => callsWith(fakes.Boss.calls, "Side job finished."), poll)
        .toBeGreaterThan(0);
      expect(timesInLast(fakes.Boss.calls, "Side job finished.")).toBe(1);
      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Boss.id }))[0]!.status, poll)
        .toBe("blocked");
    },
    timeout,
  );

  it(
    "runs a Turn for the owner's answer to an Approval, even with nothing left in the budget",
    async () => {
      const {
        deps,
        fakes,
        bots: b,
        client,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet],
        Writer: [quiet, quiet],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const [row] = await client.assignments.list({ botId: b.Writer.id });
      await getTestDb()
        .update(botAssignment)
        .set({ callLimit: 1, callsSpent: 1 })
        .where(eq(botAssignment.id, row!.id));

      await wakeFrom(deps, b.Writer.id, "approval");

      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(2);
      expect(JSON.stringify(fakes.Writer.calls[1]!.messages)).toContain("it's ready.");
    },
    timeout,
  );

  it(
    "keeps a Helper's report for the next Turn when the budget stops its own",
    async () => {
      const {
        deps,
        fakes,
        bots: b,
        client,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet],
        Writer: [quiet, quiet],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const [row] = await client.assignments.list({ botId: b.Writer.id });
      await getTestDb()
        .update(botAssignment)
        .set({ callLimit: 1, callsSpent: 1 })
        .where(eq(botAssignment.id, row!.id));

      await wakeFrom(deps, b.Writer.id, "helper");
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
      expect(fakes.Writer.calls).toHaveLength(1);

      await tell("Writer", "Any news?");
      await expect
        .poll(() => statusesOf(b.Writer.id), poll)
        .toEqual(["complete", "complete", "complete"]);
      expect(JSON.stringify(fakes.Writer.calls[1]!.messages)).toContain("it's ready.");
    },
    timeout,
  );

  it(
    "gives the Bot a child's result the budget stopped a Turn for, once the limit is raised",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots(
        {
          Scout: [assign("Writer", "Parent"), quiet],
          Writer: [assign("Editor", "Child"), quiet, quiet],
          Editor: [finish({ status: "done", outcome: "Child finished." }), quiet],
        },
        { manual: ["Editor"] },
      );
      await tell("Scout", "Hand it on.");
      await expect.poll(() => fakes.Editor.calls.length, poll).toBe(1);
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const [parent] = await client.assignments.list({ botId: b.Writer.id });
      await getTestDb()
        .update(botAssignment)
        .set({ callLimit: parent!.budget.calls + 1 })
        .where(eq(botAssignment.id, parent!.id));

      void fakes.Editor.releaseAll();
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
      const seen = fakes.Writer.calls.length;
      expect(callsWith(fakes.Writer.calls, "Child finished.")).toBe(0);

      await client.assignments.raiseLimit({
        botId: b.Writer.id,
        assignmentId: parent!.id,
        callLimit: parent!.budget.calls + 50,
      });
      await expect.poll(() => fakes.Writer.calls.length, poll).toBeGreaterThan(seen);
      expect(timesInLast(fakes.Writer.calls, "Child finished.")).toBe(1);
    },
    timeout,
  );

  it(
    "puts work a Stop set aside on the next Turn, for its budget",
    async () => {
      const {
        deps,
        fakes,
        client,
        bots: b,
        tell,
      } = await bots(
        {
          Scout: [assign("Writer", "Waiting"), quiet],
          Writer: [quiet, quiet, quiet],
        },
        { manual: ["Writer"] },
      );
      await tell("Writer", "First.");
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(1);
      await tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);
      await client.bots.stop({ botId: b.Writer.id });
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["stopped"]);
      void fakes.Writer.releaseAll();

      // A Routine's run, so nothing but the set-aside work makes this Turn one on the Assignment.
      await getTestDb().transaction(async (tx) =>
        receive(deps, tx, {
          id: `routine:${uuidv7()}:${uuidv7()}`,
          botId: b.Writer.id,
          conversationId: await conversationOf(b.Writer.id),
          source: "routine",
          channel: "schedule",
          text: "Run the report.",
          receivedAt: deps.clock(),
        }),
      );
      deps.runner.wake();

      await expect
        .poll(
          async () => (await client.assignments.list({ botId: b.Writer.id }))[0]!.budget.calls,
          poll,
        )
        .toBeGreaterThan(0);
    },
    timeout,
  );

  it(
    "files a Check-in's new work under no Assignment that arrived during it",
    async () => {
      const {
        deps,
        fakes,
        client,
        bots: b,
        tell,
      } = await bots(
        {
          Scout: [assign("Writer", "Arrives"), quiet],
          Writer: [assign("Editor", "My own"), quiet, quiet],
          Editor: [quiet],
        },
        { manual: ["Writer"] },
      );
      await getTestDb().transaction(async (tx) =>
        receive(deps, tx, {
          id: `check_in:${uuidv7()}`,
          botId: b.Writer.id,
          conversationId: await conversationOf(b.Writer.id),
          source: "check_in",
          channel: "schedule",
          text: "Come back to it.",
          receivedAt: deps.clock(),
        }),
      );
      deps.runner.wake();
      await expect.poll(() => fakes.Writer.calls.length, poll).toBe(1);
      await tell("Scout", "Hand it on.");
      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Writer.id })).length, poll)
        .toBe(1);

      void fakes.Writer.releaseAll();

      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Editor.id })).length, poll)
        .toBe(1);
      const [child] = await client.assignments.list({ botId: b.Editor.id });
      expect(child!.parent).toBeNull();
    },
    timeout,
  );

  describe("what waited behind a Stop", () => {
    /** Scout's result, or Scout's work for Writer, waits behind a Turn that Stop ends. */
    async function waitingBehindStop() {
      const made = await bots(
        {
          Boss: [assign("Editor", "Side job"), quiet, quiet, quiet, quiet],
          Editor: [finish({ status: "done", outcome: "Side job finished." }), quiet],
        },
        { manual: ["Boss"] },
      );
      await made.tell("Boss", "Start the side job.");
      await expect.poll(() => made.fakes.Boss.calls.length, poll).toBe(1);
      await made.fakes.Boss.release(assign("Editor", "Side job").length);
      await expect.poll(() => made.fakes.Boss.calls.length, poll).toBe(2);
      // The second call is held, so the Turn runs on as Editor finishes.
      await expect
        .poll(
          async () =>
            (await made.client.assignments.list({ botId: made.bots.Editor.id }))[0]?.status,
          poll,
        )
        .toBe("done");
      await made.client.bots.stop({ botId: made.bots.Boss.id });
      await expect.poll(() => statusesOf(made.bots.Boss.id), poll).toEqual(["stopped"]);
      void made.fakes.Boss.releaseAll();
      return made;
    }

    it(
      "reaches the next Turn, once, with no Turn started for it",
      async () => {
        const { fakes, bots: b, tell } = await waitingBehindStop();
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(await statusesOf(b.Boss.id)).toEqual(["stopped"]);

        await tell("Boss", "Carry on.");
        await expect.poll(() => statusesOf(b.Boss.id), poll).toEqual(["stopped", "complete"]);
        expect(timesInLast(fakes.Boss.calls, "Side job finished.")).toBe(1);
      },
      timeout,
    );

    it(
      "still reaches the next Turn when a reset came before it",
      async () => {
        const { fakes, client, bots: b, tell } = await waitingBehindStop();
        await client.bots.reset({ botId: b.Boss.id, name: "Boss" });

        await expect
          .poll(() => callsWith(fakes.Boss.calls.slice(2), "Side job finished."), poll)
          .toBe(1);
        await expect.poll(() => statusesOf(b.Boss.id), poll).toEqual(["stopped", "complete"]);
        const seen = fakes.Boss.calls.length;
        await tell("Boss", "Anything else?");
        await expect
          .poll(() => statusesOf(b.Boss.id), poll)
          .toEqual(["stopped", "complete", "complete"]);
        expect(fakes.Boss.calls.length).toBeGreaterThan(seen);
      },
      timeout,
    );
  });

  describe("waking a Bot afresh", () => {
    it(
      "adds no second Trigger to work a Turn caught up on since the reset",
      async () => {
        const {
          deps,
          client,
          bots: b,
          tell,
          user,
        } = await bots({ Scout: [assign("Writer"), quiet], Writer: [quiet, quiet, quiet] });
        await tell("Scout", "Hand it on.");
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
        const setModel = (to: string) =>
          getTestDb().update(bot).set({ model: to }).where(eq(bot.id, b.Writer.id));
        await setModel("anthropic:claude-sonnet-5-5");
        await client.bots.reset({ botId: b.Writer.id, name: "Writer" });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await setModel(model);
        await tell("Writer", "Hello.");
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
        const handOvers = async () =>
          (await triggersOf(b.Writer.id)).filter((row) => row.id.startsWith("assignment:")).length;
        const before = await handOvers();

        await wakeOnAssignments(deps, {
          botId: b.Writer.id,
          conversationId: await conversationOf(b.Writer.id),
          userId: user.id,
          model,
        });

        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(await handOvers()).toBe(before);
        expect(await statusesOf(b.Writer.id)).toEqual(["complete", "complete"]);
      },
      timeout,
    );

    it(
      "still wakes a Bot on work it had read before a pause, but not for a Trigger since the resume",
      async () => {
        const {
          deps,
          client,
          bots: b,
          tell,
          user,
        } = await bots({ Scout: [assign("Writer"), quiet], Writer: [quiet, quiet, quiet] });
        await tell("Scout", "Hand it on.");
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
        await client.bots.pause({ botId: b.Writer.id });
        await client.bots.resume({ botId: b.Writer.id });
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
        const handOvers = async () =>
          (await triggersOf(b.Writer.id)).filter((row) => row.id.startsWith("assignment:"));
        const [, second] = await handOvers();

        // A wake that lost the race to the Trigger above, as a resume's would.
        await wakeOnAssignments(
          deps,
          {
            botId: b.Writer.id,
            conversationId: await conversationOf(b.Writer.id),
            userId: user.id,
            model,
          },
          second!.receivedAt,
        );

        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(await handOvers()).toHaveLength(2);
      },
      timeout,
    );
  });

  describe("a cancel in the batch window", () => {
    /** Work reaches idle Writer as a Turn whose job hasn't started, and is cancelled at once. */
    async function cancelledWhileQueued(
      andThen?: (tell: (text: string) => Promise<unknown>) => Promise<void>,
    ) {
      const made = await bots({ Scout: [quiet], Writer: [says("Hello."), quiet] });
      await made.tell("Scout", "Hello.");
      await expect.poll(() => statusesOf(made.bots.Scout.id), poll).toEqual(["complete"]);
      const [scoutTurn] = await turnsOf(made.bots.Scout.id);
      const assigned = await getTestDb().transaction((tx) =>
        assignWork(
          made.deps,
          tx,
          { id: scoutTurn!.id, botId: made.bots.Scout.id, userId: made.user.id },
          {
            botName: "Writer",
            title: "Draft the post",
            instructions: "Write 100 words about the launch.",
          },
        ),
      );
      if ("error" in assigned) throw new Error(assigned.error);
      await made.client.assignments.cancel({
        botId: made.bots.Writer.id,
        assignmentId: assigned.assigned.id,
      });
      await andThen?.((text) => made.tell("Writer", text));
      made.deps.runner.wake();
      return made;
    }

    it(
      "ends the queued Turn with no model call, and costs nothing",
      async () => {
        const { fakes, client, bots: b, tell } = await cancelledWhileQueued();
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(fakes.Writer.calls).toHaveLength(0);
        expect((await client.assignments.list({ botId: b.Writer.id }))[0]!.budget.calls).toBe(0);

        await tell("Writer", "Are you there?");
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);
        expect(fakes.Writer.calls).toHaveLength(1);
        expect(JSON.stringify(fakes.Writer.calls[0]!.messages)).not.toContain(
          "Write 100 words about the launch.",
        );
      },
      timeout,
    );

    it(
      "leaves a Turn that took a user's Message too to run",
      async () => {
        const { fakes, bots: b } = await cancelledWhileQueued(async (tell) => {
          await tell("Are you there?");
        });
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
        expect(fakes.Writer.calls.length).toBeGreaterThan(0);
      },
      timeout,
    );
  });

  describe("a Check-in's Turn", () => {
    const checkIn = async (deps: TestDeps, botId: string) => {
      const conversationId = await conversationOf(botId);
      await getTestDb().transaction((tx) =>
        receive(deps, tx, {
          id: `check_in:${uuidv7()}`,
          botId,
          conversationId,
          source: "check_in",
          channel: "schedule",
          text: "Come back to the draft.",
          receivedAt: deps.clock(),
        }),
      );
      deps.runner.wake();
    };

    it(
      "charges no Assignment that arrived while it ran",
      async () => {
        const {
          deps,
          fakes,
          client,
          bots: b,
          tell,
        } = await bots(
          {
            Scout: [assign("Writer", "First"), quiet, assign("Writer", "Second"), quiet],
            Writer: [quiet, quiet, quiet, quiet],
          },
          { manual: ["Writer"] },
        );
        await tell("Scout", "Hand it on.");
        await expect.poll(() => fakes.Writer.calls.length, poll).toBe(1);
        await fakes.Writer.release(quiet.length);
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);

        await checkIn(deps, b.Writer.id);
        await expect.poll(() => fakes.Writer.calls.length, poll).toBe(2);
        await tell("Scout", "Hand on the second.");
        await expect
          .poll(async () => (await client.assignments.list({ botId: b.Writer.id })).length, poll)
          .toBe(2);
        void fakes.Writer.releaseAll();
        await expect
          .poll(async () => (await statusesOf(b.Writer.id)).slice(0, 2), poll)
          .toEqual(["complete", "complete"]);

        const [first, second] = await client.assignments.list({ botId: b.Writer.id });
        expect(first!.title).toBe("First");
        const checkInTurn = (await turnsOf(b.Writer.id))[1]!.id;
        expect(first!.log.some((row) => row.calls !== null && row.turnId === checkInTurn)).toBe(
          true,
        );
        expect(second!.log.some((row) => row.calls !== null && row.turnId === checkInTurn)).toBe(
          false,
        );
      },
      timeout,
    );

    it(
      "charges no parent blocked on a child",
      async () => {
        const {
          deps,
          fakes,
          client,
          bots: b,
          tell,
        } = await bots(
          {
            Scout: [assign("Writer", "Parent"), quiet],
            Writer: [assign("Editor", "Child"), quiet, quiet],
            Editor: [quiet],
          },
          { manual: ["Editor"] },
        );
        await tell("Scout", "Hand it on.");
        await expect.poll(() => fakes.Editor.calls.length, poll).toBe(1);
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
        const [parent] = await client.assignments.list({ botId: b.Writer.id });
        expect(parent!.status).toBe("blocked");

        await checkIn(deps, b.Writer.id);
        await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete", "complete"]);

        const checkInTurn = (await turnsOf(b.Writer.id))[1]!.id;
        const [after] = await client.assignments.list({ botId: b.Writer.id });
        expect(after!.log.some((row) => row.calls !== null && row.turnId === checkInTurn)).toBe(
          false,
        );
        void fakes.Editor.releaseAll();
      },
      timeout,
    );
  });

  describe("a Secret's value in what a Bot writes", () => {
    const token = "ghp_a-very-secret-token";

    it(
      "is masked in assign_work's title and instructions, and in a note",
      async () => {
        const made = await bots({
          Scout: [
            quiet,
            round(
              runs("assign_work", {
                bot: "Writer",
                title: `Use ${token}`,
                instructions: `The key is ${token}.`,
              }),
            ),
            quiet,
          ],
          Writer: [
            (call) =>
              round(
                runs("add_assignment_note", {
                  id: assignmentIdIn(call),
                  note: `Tried ${token}.`,
                }),
              ),
            quiet,
          ],
        });
        await made.client.secrets.save({
          botId: made.bots.Scout.id,
          name: "GITHUB_TOKEN",
          value: token,
        });
        await expect.poll(() => statusesOf(made.bots.Scout.id), poll).toEqual(["complete"]);
        await made.tell("Scout", "Hand it on.");

        await expect
          .poll(
            async () =>
              (await made.client.assignments.list({ botId: made.bots.Writer.id }))[0]?.log.some(
                (row) => row.note !== null,
              ),
            poll,
          )
          .toBe(true);
        const [row] = await made.client.assignments.list({ botId: made.bots.Writer.id });
        expect(JSON.stringify(row)).not.toContain(token);
        expect(row!.instructions).toContain("The key is");
        expect(JSON.stringify(made.fakes.Writer.calls[0]!.messages)).not.toContain(token);
      },
      timeout,
    );
  });

  it(
    "records read_assignment's answer, so a replay gets the same",
    async () => {
      const { bots: b, tell } = await bots({
        Scout: [round(runs("read_assignment", {})), quiet],
      });
      await tell("Scout", "Look.");
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete"]);
      const [turn] = await turnsOf(b.Scout.id);
      const history = await loadHistory(getTestDb(), turn!.jobId!);
      expect(history.map((entry) => entry.name)).toContain("read_assignment");
    },
    timeout,
  );

  it(
    "tells the parent's thread when a raise frees its child",
    async () => {
      const {
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer", "Parent"), quiet],
        Writer: [assign("Editor", "Child"), quiet],
        Editor: [round(runs("read_assignment", {})), quiet, quiet],
      });
      const writerThread = await conversationOf(b.Writer.id);
      // The chain's budget has one call left when Editor starts.
      await client.bots.pause({ botId: b.Editor.id });
      await tell("Scout", "Hand it on.");
      await expect
        .poll(async () => (await client.assignments.list({ botId: b.Editor.id })).length, poll)
        .toBe(1);
      await expect.poll(() => statusesOf(b.Writer.id), poll).toEqual(["complete"]);
      const [parent] = await client.assignments.list({ botId: b.Writer.id });
      const [child] = await client.assignments.list({ botId: b.Editor.id });
      await getTestDb()
        .update(botAssignment)
        .set({ callLimit: parent!.budget.calls + 1 })
        .where(eq(botAssignment.id, parent!.id));
      await client.bots.resume({ botId: b.Editor.id });
      await expect
        .poll(
          async () => (await client.assignments.list({ botId: b.Editor.id }))[0]!.budget.overBudget,
          poll,
        )
        .toBe(true);
      const read = await client.conversations.changes({ conversationId: writerThread, since: 0 });
      if (read.reload) throw new Error("The change log asked for a reload");
      const lastSeq = read.changes.at(-1)!.seq;

      // From the child's own page: the parent's thread has to hear of it too.
      await client.assignments.raiseLimit({
        botId: b.Editor.id,
        assignmentId: child!.id,
        callLimit: parent!.budget.calls + 50,
      });

      const after = await client.conversations.changes({
        conversationId: writerThread,
        since: lastSeq,
      });
      if (after.reload) throw new Error("The change log asked for a reload");
      expect(after.changes.map((change) => [change.kind, change.refId])).toContainEqual([
        "assignment",
        parent!.id,
      ]);
    },
    timeout,
  );

  it(
    "refuses a Bot's instructions and outcome past their caps, by the tool's own schema",
    async () => {
      const long = "x".repeat(70_000);
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [
          round(runs("assign_work", { bot: "Writer", title: "Long", instructions: long })),
          assign("Writer", "Short"),
          quiet,
        ],
        Writer: [finish({ status: "done", outcome: long }), quiet, quiet],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => toolResultsIn(fakes.Scout.calls[1]).length, poll).toBeGreaterThan(0);
      expect(JSON.stringify(toolResultsIn(fakes.Scout.calls[1]))).toMatch(
        /at most|too_big|Too big/i,
      );
      await expect.poll(() => fakes.Writer.calls.length, poll).toBeGreaterThan(1);
      expect(JSON.stringify(toolResultsIn(fakes.Writer.calls[1]))).toMatch(
        /at most|too_big|Too big/i,
      );
      const [row] = await client.assignments.list({ botId: b.Writer.id });
      expect(row!.title).toBe("Short");
      expect(row!.status).not.toBe("done");
    },
    timeout,
  );

  describe("a Turn with the owner's Message beside a hand-over", () => {
    /** Writer's second Turn takes both the work, which waited, and the owner's Message. */
    async function batched(second: Round) {
      const made = await bots(
        {
          Scout: [assign("Writer", "Parent"), quiet],
          Writer: [saysNothing, second, quiet, quiet],
          Editor: [quiet],
        },
        { manual: ["Writer"] },
      );
      await made.tell("Writer", "First.");
      await expect.poll(() => made.fakes.Writer.calls.length, poll).toBe(1);
      await made.tell("Scout", "Hand it on.");
      await expect.poll(() => statusesOf(made.bots.Scout.id), poll).toEqual(["complete"]);
      await made.tell("Writer", "Ask Editor something of mine.");
      void made.fakes.Writer.releaseAll();
      await expect
        .poll(
          async () => (await made.client.assignments.list({ botId: made.bots.Editor.id })).length,
          poll,
        )
        .toBe(1);
      const [child] = await made.client.assignments.list({ botId: made.bots.Editor.id });
      const [parent] = await made.client.assignments.list({ botId: made.bots.Writer.id });
      return { child: child!, parent: parent! };
    }

    it(
      "starts its own chain when the Bot names no parent",
      async () => {
        const { child, parent } = await batched(assign("Editor", "Mine"));
        expect(child.parent).toBeNull();
        expect(parent.children).toEqual([]);
        expect(parent.status).not.toBe("blocked");
        const [row] = await getTestDb()
          .select({ depth: botAssignment.depth })
          .from(botAssignment)
          .where(eq(botAssignment.id, child.id));
        expect(row!.depth).toBe(1);
      },
      timeout,
    );

    it(
      "files it under the Assignment the Bot names",
      async () => {
        const { child, parent } = await batched((call) =>
          round(
            runs("assign_work", {
              bot: "Editor",
              title: "Part of it",
              instructions: "Check it.",
              parent: assignmentIdIn(call),
            }),
          ),
        );
        expect(child.parent?.id).toBe(parent.id);
      },
      timeout,
    );
  });

  it(
    "says that naming a parent doesn't reset how deep a chain counts",
    async () => {
      const ids: string[] = [];
      const made = await bots({
        Scout: [
          round(
            runs("assign_work", { bot: "Writer", title: "One", instructions: "One." }),
            runs("assign_work", { bot: "Writer", title: "Two", instructions: "Two." }),
          ),
          quiet,
        ],
        Writer: [
          (call) => {
            ids.push(
              ...[
                ...JSON.stringify(call.messages.slice(1)).matchAll(/Assignment ([0-9a-f-]{36})/g),
              ].map((m) => m[1]!),
            );
            return assign("Editor");
          },
          quiet,
          quiet,
        ],
        Editor: [quiet],
      });
      await made.tell("Scout", "Hand them on.");
      await expect
        .poll(() => toolResultsIn(made.fakes.Writer.calls[1]).length, poll)
        .toBeGreaterThan(0);
      expect(JSON.stringify(toolResultsIn(made.fakes.Writer.calls[1]))).toMatch(/deepest/);
    },
    timeout,
  );

  it(
    "gives a Bot a result at most once, through resets and resumes",
    async () => {
      const {
        fakes,
        client,
        bots: b,
        tell,
      } = await bots({
        Scout: [assign("Writer"), quiet, quiet, quiet, quiet, quiet],
        Writer: [finish({ status: "done", outcome: "Once only." }), quiet],
      });
      await tell("Scout", "Hand it on.");
      await expect.poll(() => callsWith(fakes.Scout.calls, "Once only."), poll).toBe(1);
      await expect.poll(() => statusesOf(b.Scout.id), poll).toEqual(["complete", "complete"]);

      for (let reset = 0; reset < 2; reset += 1) {
        await client.bots.reset({ botId: b.Scout.id, name: "Scout" });
        await client.bots.pause({ botId: b.Scout.id });
        await client.bots.resume({ botId: b.Scout.id });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await statusesOf(b.Scout.id)).toEqual(["complete", "complete"]);
      }
      await tell("Scout", "Hello?");
      await expect
        .poll(() => statusesOf(b.Scout.id), poll)
        .toEqual(["complete", "complete", "complete"]);
      expect(JSON.stringify(fakes.Scout.calls.at(-1)!.messages)).not.toContain("Once only.");
    },
    timeout,
  );
});
