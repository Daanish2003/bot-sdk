import { and, asc, eq, isNull } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { bot, botAssignment, botAssignmentLog, botTrigger } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import {
  representative as representativeTable,
  representativeHandOff,
  representativeRelease,
} from "../src/server/db/schema";

/*
 * Choosing the Bot a Representative reports to (ticket #1194): the owner API and the test Customer
 * entry point, with a fake Model on real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
/** The Bots' Model: its Turns have a fake of their own, so they never take a Representative's rounds. */
const botModel = "openai:gpt-5.4-mini";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];
type Rpc = ReturnType<typeof chatRpc>;

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const handsOff = (title = "A refund") =>
  round(toolCall({ name: "hand_to_bot", input: { title, instructions: "They want a refund." } }));
const quiet = () => round();

/** An owner with the feature on and a runner running, a fake Model for the Representative, and one for the Bots. */
async function instance(rounds: Round[]) {
  const fake = createFakeAdapter({ rounds });
  const botFake = createFakeAdapter({ rounds: Array.from({ length: 40 }, () => quiet()) });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [representative()],
    adapterFor: (id) => (id === botModel ? botFake.adapter : fake.adapter),
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
  return { fake, botFake, deps, user, rpc: chatRpc({ user, deps }) };
}

/** A Representative switched on, on a first Release. */
async function liveRepresentative(rpc: Rpc, botId?: string, name = "Front desk") {
  const { id } = await rpc.representative.create({ name, botId });
  await rpc.representative.updateDraft({ id, draft: { jobText: "Answer questions.", model } });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  return id;
}

const assignmentsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botAssignment)
    .where(eq(botAssignment.assignedBotId, botId))
    .orderBy(asc(botAssignment.createdAt), asc(botAssignment.id));

const logOf = (assignmentId: string) =>
  getTestDb()
    .select({
      status: botAssignmentLog.status,
      actor: botAssignmentLog.actor,
      note: botAssignmentLog.note,
    })
    .from(botAssignmentLog)
    .where(eq(botAssignmentLog.assignmentId, assignmentId))
    .orderBy(asc(botAssignmentLog.at), asc(botAssignmentLog.id));

const liveHandOversOf = (botId: string) =>
  getTestDb()
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(
      and(
        eq(botTrigger.botId, botId),
        eq(botTrigger.source, "assignment"),
        isNull(botTrigger.skippedAt),
      ),
    );

describe("choosing the Bot a Representative reports to", () => {
  it("moves its open Assignments to the chosen Bot, each with a log row, and wakes the new Bot", async () => {
    const { botFake, deps, rpc } = await instance([handsOff("First"), handsOff("Second"), quiet()]);
    const { id: first } = await rpc.bots.create({ name: "First", model: botModel });
    const { id: second } = await rpc.bots.create({ name: "Second", model: botModel });
    const id = await liveRepresentative(rpc, first);
    await testCustomerTurn(deps, { representativeId: id, message: "Hi" });
    const [done, open] = await assignmentsOf(first);
    // One has ended already: it stays where it was.
    await getTestDb()
      .update(botAssignment)
      .set({ status: "cancelled", endedAt: new Date() })
      .where(eq(botAssignment.id, done!.id));
    await expect.poll(() => botFake.calls.length, poll).toBeGreaterThan(0);
    const wakes = botFake.calls.length;

    const chosen = await rpc.representative.setBot({ id, botId: second });

    expect(chosen.botId).toBe(second);
    expect((await rpc.representative.list())[0]?.botId).toBe(second);
    expect((await assignmentsOf(second)).map((row) => row.id)).toEqual([open!.id]);
    expect((await assignmentsOf(first)).map((row) => row.id)).toEqual([done!.id]);
    expect(await logOf(open!.id)).toContainEqual({
      status: expect.stringMatching(/^(open|working)$/),
      actor: "feature",
      note: expect.stringContaining("Second"),
    });
    expect(await logOf(done!.id)).not.toContainEqual(
      expect.objectContaining({ note: expect.stringContaining("Second") }),
    );
    await expect.poll(() => botFake.calls.length, poll).toBeGreaterThan(wakes);
    expect(await liveHandOversOf(second)).not.toEqual([]);
  });

  it("leaves another Representative's Assignments on the old Bot", async () => {
    const { deps, rpc } = await instance([handsOff("Mine"), quiet(), handsOff("Theirs"), quiet()]);
    const { id: first } = await rpc.bots.create({ name: "First", model: botModel });
    const { id: second } = await rpc.bots.create({ name: "Second", model: botModel });
    const mine = await liveRepresentative(rpc, first, "Mine");
    const theirs = await liveRepresentative(rpc, first, "Theirs");
    await testCustomerTurn(deps, { representativeId: mine, message: "Hi" });
    await testCustomerTurn(deps, { representativeId: theirs, message: "Hi" });

    await rpc.representative.setBot({ id: mine, botId: second });

    expect((await assignmentsOf(second)).map((row) => row.title)).toEqual(["Mine"]);
    expect((await assignmentsOf(first)).map((row) => row.title)).toEqual(["Theirs"]);
  });

  it("is limited to the owner's Bots and Representatives", async () => {
    const { deps, rpc } = await instance([]);
    const { id: botId } = await rpc.bots.create({ name: "Mine", model: botModel });
    const id = await liveRepresentative(rpc, botId);
    const stranger = await insertUser();
    await saveCredentials(deps, stranger.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const strangerRpc = chatRpc({ user: stranger, deps });
    const { id: theirBot } = await strangerRpc.bots.create({ name: "Theirs", model: botModel });

    await expect(rpc.representative.setBot({ id, botId: theirBot })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(strangerRpc.representative.setBot({ id, botId: theirBot })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    expect((await rpc.representative.get({ id })).botId).toBe(botId);
  });

  it("keeps the old Bot and its Assignments when the new Bot can't take them", async () => {
    const { deps, user, rpc } = await instance([handsOff(), quiet()]);
    const { id: first } = await rpc.bots.create({ name: "First", model: botModel });
    const { id: second } = await rpc.bots.create({ name: "Second", model: botModel });
    const id = await liveRepresentative(rpc, first);
    await testCustomerTurn(deps, { representativeId: id, message: "Hi" });
    // The new Bot's Model has no credential, so it can't work.
    await getTestDb()
      .update(bot)
      .set({ model: "anthropic:claude-haiku-4-5" })
      .where(and(eq(bot.id, second), eq(bot.userId, user.id)));

    await expect(rpc.representative.setBot({ id, botId: second })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await assignmentsOf(second)).toEqual([]);
    expect(await assignmentsOf(first)).toHaveLength(1);
  });
});

describe("a Representative whose Bot's row is gone", () => {
  it("reports to the owner, keeps answering, and reports to the Bot chosen next", async () => {
    const { fake, deps, rpc } = await instance([quiet(), handsOff(), quiet()]);
    const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
    const { id: next } = await rpc.bots.create({ name: "Next", model: botModel });
    const id = await liveRepresentative(rpc, botId);
    await getTestDb().delete(bot).where(eq(bot.id, botId));

    expect(await rpc.representative.get({ id })).toMatchObject({ botId: null, enabled: true });
    await testCustomerTurn(deps, { representativeId: id, message: "Hi" });
    expect(fake.calls).toHaveLength(1);

    await rpc.representative.setBot({ id, botId: next });
    await testCustomerTurn(deps, { representativeId: id, message: "Hi again" });
    expect(await assignmentsOf(next)).toHaveLength(1);
  });
});

describe("a Bot reset", () => {
  it("keeps the Representative, its Releases and its open Assignments", async () => {
    const { deps, rpc } = await instance([handsOff(), quiet()]);
    const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
    const id = await liveRepresentative(rpc, botId);
    await testCustomerTurn(deps, { representativeId: id, message: "Hi" });
    const [before] = await assignmentsOf(botId);

    await rpc.bots.reset({ botId, name: "Clerk" });

    expect(await rpc.representative.get({ id })).toMatchObject({
      botId,
      enabled: true,
      liveReleaseNumber: 1,
    });
    expect(
      await getTestDb()
        .select({ id: representativeRelease.id })
        .from(representativeRelease)
        .where(eq(representativeRelease.representativeId, id)),
    ).toHaveLength(1);
    expect(await assignmentsOf(botId)).toEqual([
      expect.objectContaining({
        id: before!.id,
        status: expect.stringMatching(/^(open|working)$/),
      }),
    ]);
    expect(
      await getTestDb()
        .select()
        .from(representativeHandOff)
        .where(eq(representativeHandOff.assignmentId, before!.id)),
    ).toHaveLength(1);
    expect(
      await getTestDb().select().from(representativeTable).where(eq(representativeTable.id, id)),
    ).toHaveLength(1);
  });
});
