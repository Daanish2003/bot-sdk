import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import {
  claimJob,
  inProcessRunner,
  type JobRunner,
  reapStaleJobs,
} from "@botsdk/bot/runner/internal";
import { bot, botAssignment, conversation, job } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { startTestCustomerTurn } from "@ai-chat/test-support/test-customer";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import {
  representative as representativeTable,
  representativeHandOff,
} from "../src/server/db/schema";

/*
 * A hand-off replayed after a crash (#1202): the Assignment and its hand-off row commit with the
 * tool call's Checkpoint, so a replay never makes a second one. Jobs run by hand, one attempt at a
 * time, on real Postgres with a fake Model. A crash is what `reapStaleJobs` makes of one: the attempt
 * no longer owns its job, so whatever it does next saves nothing.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
/** The Bot's Model: its Turns have a fake of their own, so they never take a Representative's rounds. */
const botModel = "openai:gpt-5.4-mini";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };

const handsOff = () =>
  round(
    toolCall({
      name: "hand_to_bot",
      input: { title: "A refund", instructions: "They want a refund." },
    }),
  );
const quiet = () => round();

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const toolResults = (fake: { calls: Array<{ messages: unknown }> }) =>
  (fake.calls.at(-1)!.messages as Array<{ role: string; content: unknown }>)
    .filter((entry) => entry.role === "tool")
    .map((entry) => JSON.parse(String(entry.content)) as unknown);

describe("a hand-off replayed after a crash", () => {
  // The test claims jobs by hand: none another test left behind may be claimed first.
  beforeEach(async () => {
    await getTestDb()
      .update(job)
      .set({ status: "cancelled" })
      .where(inArray(job.status, ["queued", "running"]));
  });

  /** A Representative reporting to a Bot, its Turn queued, on a fake clock with jobs run by hand. */
  async function queuedHandOff() {
    const fake = createFakeAdapter({ rounds: [handsOff(), quiet()] });
    const botFake = createFakeAdapter({ rounds: Array.from({ length: 20 }, () => quiet()) });
    const timer = fakeJobClock(new Date());
    let deps: TestDeps | undefined;
    const jobs = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      clock: timer.clock,
      drainMs: 1_000,
      jobs: () => deps!.parts.jobs,
    });
    runners.push(jobs);
    deps = createTestSdk({
      jobs,
      features: [representative()],
      adapterFor: (id) => (id === botModel ? botFake.adapter : fake.adapter),
      memory: false,
    });
    const user = await insertUser();
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const rpc = chatRpc({ user, deps });
    const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
    const { id } = await rpc.representative.create({ name: "Front desk", botId });
    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer questions.", model } });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    const { jobId } = await startTestCustomerTurn(deps, { representativeId: id, message: "Hi" });
    const { assignments, threads } = deps.parts.features[0]!.context;
    return {
      fake,
      deps,
      botId,
      assignments: assignments!,
      threads: threads!,
      crash: async () => {
        timer.advance(61_000);
        await reapStaleJobs(getTestDb(), timer.clock.now(), silent, deps!.parts.jobs);
        timer.tick();
      },
      /** Runs attempts until the Turn's job ends. */
      turnEnds: async () => {
        for (let tries = 0; tries < 10; tries += 1) {
          const status = await deps!.runner.status(jobId);
          if (status?.status === "succeeded") return;
          const claimed = await claimJob(getTestDb(), timer.clock.now(), {
            respectRunAfter: false,
          });
          if (!claimed) throw new Error(`Nothing to claim, with the Turn ${status?.status}`);
          await jobs.runClaimed(claimed, {});
        }
        throw new Error("The Turn never ended");
      },
    };
  }

  const expectOneHandOff = async (botId: string) => {
    const made = await getTestDb()
      .select({ id: botAssignment.id })
      .from(botAssignment)
      .where(eq(botAssignment.assignedBotId, botId));
    expect(made).toHaveLength(1);
    expect(await getTestDb().select().from(representativeHandOff)).toEqual([
      expect.objectContaining({ assignmentId: made[0]!.id }),
    ]);
  };

  it("starts a chain of its own at depth 1, having no Bot Turn behind it (#1186)", async () => {
    const { botId, turnEnds } = await queuedHandOff();

    await turnEnds();

    expect(
      await getTestDb()
        .select({ depth: botAssignment.depth, parent: botAssignment.parentAssignmentId })
        .from(botAssignment)
        .where(eq(botAssignment.assignedBotId, botId)),
    ).toEqual([{ depth: 1, parent: null }]);
  });

  it("leaves one of each after a crash between the Assignment and its hand-off row", async () => {
    const { fake, botId, assignments, crash, turnEnds } = await queuedHandOff();
    const create = assignments.create.bind(assignments);
    vi.spyOn(assignments, "create").mockImplementationOnce(async (...args) => {
      await create(...args);
      await crash();
      // The process is gone: nothing it would have done next happens.
      throw new Error("The process died");
    });

    await turnEnds();

    await expectOneHandOff(botId);
    expect(toolResults(fake)).toEqual([{ handedOff: true }]);
  });

  it("leaves one of each after a crash before the Checkpoint saves", async () => {
    const { fake, botId, assignments, crash, turnEnds } = await queuedHandOff();
    const create = assignments.create.bind(assignments);
    vi.spyOn(assignments, "create").mockImplementationOnce(async (...args) => {
      const made = await create(...args);
      // Whatever this attempt writes from here on, its Checkpoint won't save.
      await crash();
      return made;
    });

    await turnEnds();

    await expectOneHandOff(botId);
    expect(toolResults(fake)).toEqual([{ handedOff: true }]);
  });

  it("leaves one of each after a crash while hinting the thread", async () => {
    const { fake, deps, botId, crash, turnEnds } = await queuedHandOff();
    vi.spyOn(deps.pubsub, "publish").mockImplementationOnce(async () => {
      await crash();
      throw new Error("The process died");
    });

    await turnEnds();

    await expectOneHandOff(botId);
    expect(toolResults(fake)).toEqual([{ handedOff: true }]);
  });

  it("makes no second Assignment when hinting the thread fails, and the Model hears it handed off", async () => {
    const { fake, botId, threads, turnEnds } = await queuedHandOff();
    vi.spyOn(threads, "hintChanged").mockRejectedValueOnce(new Error("The hint failed"));

    await turnEnds();

    await expectOneHandOff(botId);
    expect(fake.calls).toHaveLength(2);
    expect(toolResults(fake)).toEqual([{ handedOff: true }]);
  });

  it("takes the Representative's row before the Conversation's lock, as the owner's choices do", async () => {
    const { fake, botId, assignments, turnEnds } = await queuedHandOff();
    const create = vi.spyOn(assignments, "create");
    const [owner] = await getTestDb()
      .select({ conversationId: bot.conversationId })
      .from(bot)
      .where(eq(bot.id, botId));
    let turn: Promise<void> | undefined;

    // What choosing another Bot does when it drops an Approval: the row first, then the Conversation.
    await getTestDb().transaction(async (tx) => {
      await tx.select().from(representativeTable).for("update");
      turn = turnEnds();
      await expect.poll(() => fake.calls.length, poll).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // It waits for the row, holding no Conversation lock that this would wait on in turn.
      expect(create).not.toHaveBeenCalled();
      await tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(eq(conversation.id, owner!.conversationId))
        .for("update");
    });

    await turn;
    await expectOneHandOff(botId);
  });
});
