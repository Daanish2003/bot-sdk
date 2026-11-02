import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { conversationChannel } from "../../src/chat/conversation-events";
import { bot, botAssignment, botTrigger, botTurn } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { deleteUserData, exportUserData } from "../../src/user-data";
import { assignmentTools } from "../../src/bot/assignments";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { botContract } from "@botsdk/client/bot/contract";
import { taskCount } from "@botsdk/client/bot/tasks";
import { createFakeAdapter, type FakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
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
        assignments: { log: Record<string, unknown>[] }[];
      };
      const [assignment] = exported.assignments;
      expect(assignment!.log).toMatchObject([
        { status: "open", actor: "bot", actorBotId: b.Scout.id },
        { status: "working", actor: "system", actorBotId: null },
        { status: "done", actor: "bot", actorBotId: b.Writer.id },
      ]);
      for (const row of assignment!.log) expect(row.turnId).toEqual(expect.any(String));
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
      expect(change?.data).toMatchObject({ id: row!.id, title: "Draft the post" });
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
        row!.log.map((entry) => [entry.status, entry.actor, entry.actorName, entry.note]),
      ).toEqual([
        ["open", "bot", "Scout", null],
        ["working", "system", null, null],
        ["working", "bot", "Writer", "Halfway there."],
      ]);
      const [writerTurn] = await turnsOf(b.Writer.id);
      expect(row!.log[2]!.turnId).toBe(writerTurn!.id);

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
      expect(after!.log).toHaveLength(3);
    },
    timeout,
  );

  it(
    "offers no way to create, edit or remove a log row, or to create an Assignment, to the owner",
    async () => {
      expect(Object.keys(botContract.assignments).sort()).toEqual(["cancel", "list"]);
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
