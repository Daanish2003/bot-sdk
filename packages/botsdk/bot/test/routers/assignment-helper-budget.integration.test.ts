import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botHelperJob, helperEndings } from "../../src/bot/helpers";
import { receive } from "../../src/bot/triggers";
import { uuidv7 } from "../../src/lib/uuidv7";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner, loadHistory } from "../../src/runner/internal";
import {
  bot,
  botAssignment,
  botAssignmentLog,
  botHelper,
  botTrigger,
  botTurn,
  usage,
} from "../../src/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, text, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { fakeReviewer, type FakeReviewer } from "@botsdk/testing/fake-reviewer";

/*
 * A Helper and the Assignments of the Turn that started it (#1196): real Turns and Helpers with the
 * fake Model on real Postgres. Its model calls are charged to those Assignments, and at the limit it
 * stops and reports what it has so far.
 */

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const timeout = 30_000;
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: JobRunner[] = [];
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** Whether a model call is a Helper's: its system prompt says so. */
const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) =>
    (typeof prompt === "string" ? prompt : prompt.content).startsWith("You are a Helper"),
  );

/** The Bot a Turn's call is from, as its Prompt start names it. */
const callerOf = (call: TextOptions) => /Your name: (\w+)/.exec(JSON.stringify(call.messages))?.[1];

const runs = (name: string, args: unknown) => toolCall({ name: "run_tool", input: { name, args } });

const assign = (title = "Draft the post") =>
  round(runs("assign_work", { bot: "Writer", title, instructions: "Write 100 words." }));

const quiet = round();

const startHelper = toolCall({
  name: "start_helper",
  input: { type: "general", task: "Count the files." },
});

const ends = toolCall({ name: "send_to_user", input: { text: "On it.", endTurn: true } });

/** A Turn's Step: it starts a Helper and ends. */
const handsOff = round(startHelper, ends);

/** A Helper's Step that goes on to another, having said `said` if anything. */
const working = (said?: string) =>
  round(...(said ? [text(said)] : []), toolCall({ name: "list", input: {} }));

/** The Assignment id the newest Trigger text in a call names. */
const assignmentIdIn = (call: TextOptions) =>
  /Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/.exec(JSON.stringify(call.messages.slice(1)))![1]!;

/** A user with an OpenAI key and the Bots Scout and Writer, whose Helpers play `helper`. */
async function bots({
  scout = [assign(), quiet],
  writer,
  helper,
  manualWriter = false,
  manualHelper = false,
  reviewer,
}: {
  scout?: Round[];
  writer: Round[];
  helper: Round[];
  manualWriter?: boolean;
  manualHelper?: boolean;
  reviewer?: FakeReviewer;
}) {
  const scoutFake = createFakeAdapter({ rounds: scout });
  const writerFake = createFakeAdapter({ rounds: writer, manual: manualWriter });
  const helperFake = createFakeAdapter({ rounds: helper, manual: manualHelper });
  const adapter: AnyTextAdapter = {
    ...scoutFake.adapter,
    chatStream: (options: TextOptions) => {
      if (isHelperCall(options)) return helperFake.adapter.chatStream(options);
      return (callerOf(options) === "Scout" ? scoutFake : writerFake).adapter.chatStream(options);
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
    computer: fakeComputerProvider().provider,
    memory: false,
    ...(reviewer && { reviewAdapterFor: () => reviewer.adapter }),
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
  const scoutBot = await client.bots.create({ name: "Scout", model });
  const writerBot = await client.bots.create({ name: "Writer", model });
  const tell = (botId: string, said: string) =>
    client.bots.send({ botId, id: uuidv7(), text: said });
  return {
    deps,
    client,
    tell,
    scoutId: scoutBot.id,
    writerId: writerBot.id,
    writerFake,
    helperFake,
  };
}

type Made = Awaited<ReturnType<typeof bots>>;

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt));

const statusesOf = async (botId: string) => (await turnsOf(botId)).map((turn) => turn.status);

const helperOf = async (botId: string) =>
  (await getTestDb().select().from(botHelper).where(eq(botHelper.botId, botId)))[0];

const helperEnded = async (botId: string) => (await helperOf(botId))?.endedAt ?? null;

/** The model calls Turn `turnId` and its Helpers put on Assignment `id`'s log. */
async function callsLogged(id: string, turnId: string) {
  const rows = await getTestDb()
    .select({ calls: botAssignmentLog.calls })
    .from(botAssignmentLog)
    .where(and(eq(botAssignmentLog.assignmentId, id), eq(botAssignmentLog.turnId, turnId)));
  return rows.reduce((sum, row) => sum + (row.calls ?? 0), 0);
}

/**
 * Scout hands Writer the work while Writer is paused, the limit is set, and Writer is resumed, so
 * its first Turn already works to it. It returns the first Assignment's id.
 */
async function limited(made: Made, callLimit = 30) {
  await made.client.bots.pause({ botId: made.writerId });
  await made.tell(made.scoutId, "Hand it on.");
  await expect.poll(() => statusesOf(made.scoutId), poll).toEqual(["complete"]);
  const rows = await made.client.assignments.list({ botId: made.writerId });
  for (const row of rows) {
    await getTestDb().update(botAssignment).set({ callLimit }).where(eq(botAssignment.id, row.id));
  }
  await made.client.bots.resume({ botId: made.writerId });
  return rows[0]!.id;
}

const budgetOf = async (made: Made, index = 0) =>
  (await made.client.assignments.list({ botId: made.writerId }))[index]!.budget;

describe("a Helper's model calls and the Assignments of the Turn that started it", () => {
  it(
    "counts them against the Assignment, on its log under that Turn",
    async () => {
      const made = await bots({
        writer: [handsOff, quiet],
        helper: [working(), working(), round(text("3 files."))],
      });
      const id = await limited(made);

      await expect.poll(() => statusesOf(made.writerId), poll).toEqual(["complete", "complete"]);
      expect(await helperOf(made.writerId)).toMatchObject({
        status: "complete",
        report: "3 files.",
      });
      expect(made.helperFake.calls).toHaveLength(3);

      // The starting Turn's call, the Helper's three, and the report's Turn.
      expect((await budgetOf(made)).calls).toBe(5);
      const [first] = await turnsOf(made.writerId);
      expect(await callsLogged(id, first!.id)).toBe(4);
    },
    timeout,
  );

  it(
    "counts them against each Assignment when the Turn is on several",
    async () => {
      const made = await bots({
        scout: [
          round(
            runs("assign_work", { bot: "Writer", title: "One", instructions: "First." }),
            runs("assign_work", { bot: "Writer", title: "Two", instructions: "Second." }),
          ),
          quiet,
        ],
        writer: [handsOff, quiet],
        helper: [working(), round(text("Done."))],
      });
      await limited(made);

      await expect.poll(() => statusesOf(made.writerId), poll).toEqual(["complete", "complete"]);
      expect((await budgetOf(made, 0)).calls).toBe(4);
      expect((await budgetOf(made, 1)).calls).toBe(4);
    },
    timeout,
  );

  it(
    "stops at the limit and reports what it has so far, and the report's Turn asks the owner",
    async () => {
      const made = await bots({
        writer: [handsOff, quiet],
        helper: [working("Found 3 files so far."), working(), working(), round(text("Unreached."))],
      });
      await limited(made, 3);

      await expect.poll(() => helperEnded(made.writerId), poll).not.toBeNull();
      // The Turn's call and two of the Helper's reach the limit: no third is made.
      expect(made.helperFake.calls).toHaveLength(2);
      const report = helperEndings.overBudget("Found 3 files so far.");
      const helper = await helperOf(made.writerId);
      expect(helper).toMatchObject({ status: "error", report });
      expect(helper!.usage).not.toBeNull();
      expect(JSON.stringify(helper!.transcript)).toContain("Found 3 files so far.");

      const triggers = await getTestDb()
        .select({ text: botTrigger.text })
        .from(botTrigger)
        .where(and(eq(botTrigger.botId, made.writerId), eq(botTrigger.source, "helper")));
      expect(triggers).toHaveLength(1);
      expect(triggers[0]!.text).toContain("status error");
      expect(triggers[0]!.text).toContain(report);

      await expect.poll(() => statusesOf(made.writerId), poll).toEqual(["complete", "complete"]);
      const [row] = await made.client.assignments.list({ botId: made.writerId });
      expect(row).toMatchObject({ status: "blocked", budget: { calls: 3, overBudget: true } });
      // The Turn the report started stopped before calling the Model.
      expect(made.writerFake.calls).toHaveLength(1);
    },
    timeout,
  );

  it(
    "says so when it has produced nothing yet",
    async () => {
      const made = await bots({ writer: [handsOff, quiet], helper: [round(text("Unreached."))] });
      await limited(made, 1);

      await expect.poll(() => helperEnded(made.writerId), poll).not.toBeNull();
      expect(made.helperFake.calls).toHaveLength(0);
      expect(await helperOf(made.writerId)).toMatchObject({
        status: "error",
        report: helperEndings.overBudget(""),
      });
      expect(helperEndings.overBudget("")).not.toContain("undefined");
    },
    timeout,
  );

  it(
    "leaves a Helper from a Turn on no Assignment as it was, with no check at all",
    async () => {
      const made = await bots({
        scout: [handsOff, quiet],
        writer: [],
        helper: [working(), round(text("Done."))],
      });
      await made.tell(made.scoutId, "Count them.");

      await expect.poll(() => statusesOf(made.scoutId), poll).toEqual(["complete", "complete"]);
      const helper = await helperOf(made.scoutId);
      expect(helper).toMatchObject({ status: "complete", report: "Done." });
      const history = await loadHistory(getTestDb(), helper!.jobId!);
      const names = history.map((entry) => entry.name);
      expect(names).toContain("model");
      expect(names).not.toContain("assignment_budget");
    },
    timeout,
  );

  it(
    "leaves Auto-review's calls uncounted",
    async () => {
      const reviewer = fakeReviewer();
      const made = await bots({
        writer: [handsOff, quiet],
        helper: [
          round(toolCall({ name: "shell", input: { command: "ls" } })),
          round(text("Done.")),
        ],
        reviewer,
      });
      await limited(made);

      await expect.poll(() => statusesOf(made.writerId), poll).toEqual(["complete", "complete"]);
      const helper = await helperOf(made.writerId);
      expect(helper!.status).toBe("complete");
      expect(reviewer.calls).toHaveLength(1);
      const reviews = await getTestDb()
        .select({ id: usage.id })
        .from(usage)
        .where(and(eq(usage.kind, "review"), eq(usage.sourceId, helper!.id)));
      expect(reviews).toHaveLength(1);
      // The starting Turn's call, the Helper's two, and the report's Turn: not the review.
      expect((await budgetOf(made)).calls).toBe(4);
    },
    timeout,
  );

  it(
    "runs on uncounted once the Assignment ended, as there's no budget left to keep to",
    async () => {
      const made = await bots({
        scout: [assign(), quiet, quiet],
        writer: [
          (call) =>
            round(
              startHelper,
              runs("finish_assignment", {
                id: assignmentIdIn(call),
                status: "done",
                outcome: "Drafted.",
              }),
              ends,
            ),
          quiet,
        ],
        helper: [working(), round(text("Done."))],
        manualHelper: true,
      });
      const id = await limited(made);
      await expect.poll(() => made.helperFake.calls.length, poll).toBe(1);
      await expect
        .poll(
          async () => (await made.client.assignments.list({ botId: made.writerId }))[0]!.status,
          poll,
        )
        .toBe("done");
      await getTestDb().update(botAssignment).set({ callLimit: 1 }).where(eq(botAssignment.id, id));

      await made.helperFake.releaseAll();
      await expect.poll(() => helperEnded(made.writerId), poll).not.toBeNull();
      expect(made.helperFake.calls).toHaveLength(2);
      expect(await helperOf(made.writerId)).toMatchObject({ status: "complete", report: "Done." });
      expect((await budgetOf(made)).calls).toBe(1);
    },
    timeout,
  );

  it(
    "runs on uncounted once the Assignment moved to another Bot, whose work it no longer is",
    async () => {
      const made = await bots({
        writer: [handsOff, quiet],
        helper: [working(), round(text("Done."))],
        manualHelper: true,
      });
      const id = await limited(made);
      await expect.poll(() => made.helperFake.calls.length, poll).toBe(1);
      await getTestDb()
        .update(botAssignment)
        .set({ assignedBotId: made.scoutId, callLimit: 1 })
        .where(eq(botAssignment.id, id));

      await made.helperFake.releaseAll();
      await expect.poll(() => helperEnded(made.writerId), poll).not.toBeNull();
      expect(made.helperFake.calls).toHaveLength(2);
      expect(await helperOf(made.writerId)).toMatchObject({ status: "complete", report: "Done." });
      const [row] = await getTestDb()
        .select({ calls: botAssignment.callsSpent })
        .from(botAssignment)
        .where(eq(botAssignment.id, id));
      expect(row!.calls).toBe(1);
    },
    timeout,
  );

  it(
    "keeps charging the same Assignments when a Stop attaches the user's waiting Message to its Turn",
    async () => {
      const step = round(startHelper, runs("read_assignment", {}));
      const next = round(runs("read_assignment", {}));
      const made = await bots({
        writer: [quiet, step, next, quiet],
        helper: [working(), round(text("Done."))],
        manualWriter: true,
        manualHelper: true,
      });
      const id = await limited(made);
      await expect.poll(() => made.writerFake.calls.length, poll).toBe(1);
      await made.writerFake.release(quiet.length);
      await expect.poll(() => statusesOf(made.writerId), poll).toEqual(["complete"]);

      // A Check-in's Turn is on the Bot's open Assignments, as long as no user asked for it.
      const [own] = await getTestDb()
        .select({ conversationId: bot.conversationId })
        .from(bot)
        .where(eq(bot.id, made.writerId));
      await getTestDb().transaction((tx) =>
        receive(made.deps, tx, {
          id: `check_in:${uuidv7()}`,
          botId: made.writerId,
          conversationId: own!.conversationId,
          source: "check_in",
          channel: "schedule",
          text: "Come back to it.",
          receivedAt: made.deps.clock(),
        }),
      );
      made.deps.runner.wake();
      await expect.poll(() => made.writerFake.calls.length, poll).toBe(2);
      await made.writerFake.release(step.length);
      await expect.poll(() => made.helperFake.calls.length, poll).toBe(1);
      await expect.poll(() => made.writerFake.calls.length, poll).toBe(3);

      await made.tell(made.writerId, "Are you there?").catch(() => {});
      await made.client.bots.stop({ botId: made.writerId });
      await expect
        .poll(async () => (await turnsOf(made.writerId))[1]?.status, poll)
        .not.toBe("running");
      const turn = (await turnsOf(made.writerId))[1]!;
      const taken = await getTestDb()
        .select({ source: botTrigger.source })
        .from(botTrigger)
        .where(eq(botTrigger.turnId, turn.id));
      expect(taken.map((row) => row.source)).toContain("user");

      await made.helperFake.releaseAll();
      await expect.poll(() => helperEnded(made.writerId), poll).not.toBeNull();
      // That Turn's first call and the Helper's two; its second was cut off, so it bills nothing.
      expect(await callsLogged(id, turn.id)).toBe(3);
      await made.writerFake.releaseAll();
    },
    timeout,
  );

  it(
    "replays its recorded checks when its job is given up on, and charges nothing again",
    async () => {
      const made = await bots({
        writer: [handsOff, quiet],
        helper: [working("Found some."), round(text("Unreached."))],
        manualHelper: true,
      });
      await limited(made);
      await expect.poll(() => made.helperFake.calls.length, poll).toBe(1);
      await made.helperFake.release(working("Found some.").length);
      await expect.poll(() => made.helperFake.calls.length, poll).toBe(2);
      const spent = (await budgetOf(made)).calls;
      const helper = await helperOf(made.writerId);

      await botHelperJob.onFailed!({ helperId: helper!.id }, new Error("lost"), {
        deps: made.deps,
      });

      const lost = await helperOf(made.writerId);
      expect(lost).toMatchObject({ status: "error", report: helperEndings.crashed });
      // A failed replay would keep only the task.
      expect(JSON.stringify(lost!.transcript)).toContain("Found some.");
      expect((await budgetOf(made)).calls).toBe(spent);
      await made.helperFake.releaseAll();
    },
    timeout,
  );

  it(
    "replays cleanly when its job recorded nothing, past the end of the history",
    async () => {
      const made = await bots({ writer: [quiet], helper: [] });
      await limited(made);
      await expect.poll(() => statusesOf(made.writerId), poll).toEqual(["complete"]);
      const [turn] = await turnsOf(made.writerId);
      const helperId = uuidv7();
      await getTestDb().insert(botHelper).values({
        id: helperId,
        botId: made.writerId,
        type: "general",
        task: "Count the files.",
        status: "running",
        startedByTurnId: turn!.id,
        startedAt: made.deps.clock(),
      });
      const logged = vi.spyOn(made.deps.logger, "error");

      await botHelperJob.onFailed!({ helperId }, new Error("lost"), { deps: made.deps });

      expect(logged).not.toHaveBeenCalled();
      expect(await helperOf(made.writerId)).toMatchObject({
        status: "error",
        report: helperEndings.crashed,
      });
    },
    timeout,
  );
});
