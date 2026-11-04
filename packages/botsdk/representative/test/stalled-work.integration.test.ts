import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { claimJob, inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { botAssignment } from "@botsdk/bot/storage";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { fakeChannel, promoteAutoTopic } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { noCustomerChannel } from "../src/server/customer-proof";
import { representativeFeature } from "../src/server/plugin";
import { stallNote } from "../src/server/stalled-work";
import { receiveCustomerMessage } from "../src/server/thread-turns";

/*
 * Stalled work Pages the owner (ticket #1312). A fake clock drives the Assignment's due time and the
 * owner's two-hour wait; fake Models and a fake Channel on real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const silent = { error: () => {} };
const number = "+15550001";
const minute = 60_000;

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

const quiet = () => round();
const handsOff = () =>
  round(
    toolCall({
      name: "hand_to_bot",
      input: { title: "A refund", instructions: "They want a refund." },
    }),
  );
// No source for an answer: the gate's check refuses it, and a second refusal hands off in code.
const refused = () =>
  round(
    toolCall({
      name: "reply",
      input: { topic: "general", sources: [], text: "It is 20.", kind: "answer" },
    }),
  );
const finishes = (call: { messages: unknown }) =>
  round(
    toolCall({
      name: "run_tool",
      input: {
        name: "finish_assignment",
        args: {
          id: /Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/.exec(
            JSON.stringify((call.messages as unknown[]).slice(1)),
          )![1],
          status: "done",
          outcome: "Refunded.",
        },
      },
    }),
  );

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

async function serving(representativeRounds: Rounds, botRounds: Rounds = [quiet], withBot = true) {
  const fake = createFakeAdapter({ rounds: representativeRounds });
  const botFake = createFakeAdapter({ rounds: botRounds });
  const timer = fakeJobClock(new Date("2026-11-04T10:00:00Z"));
  let made: ReturnType<typeof createTestSdk> | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    clock: timer.clock,
    drainMs: 1_000,
    jobs: () => made!.parts.jobs,
  });
  runners.push(jobs);
  const deps = createTestSdk({
    jobs,
    clock: timer.clock.now,
    features: [representativeFeature({}, noCustomerChannel)],
    adapterFor: (id) => (id === botModel ? botFake.adapter : fake.adapter),
    memory: false,
  });
  made = deps;
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "...-key",
    verified: true,
  });
  const rpc = chatRpc({ user, deps });
  const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
  const { id } = await rpc.representative.create({
    name: "Front desk",
    ...(withBot && { botId }),
  });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tools: ["reply", "hand_to_bot"] },
  });
  await rpc.representative.approve({ id });
  await rpc.representative.setEnabled({ id, enabled: true });
  await promoteAutoTopic(id);
  const feature = deps.parts.features.find(({ feature }) => feature.id === "representative")!;
  const thread = async () => {
    const [summary] = await rpc.representative.threadList({ id });
    return rpc.representative.threadGet({ id: summary!.id });
  };
  const runNext = async () => {
    timer.advance(1_000);
    const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
    if (!claimed) return false;
    await jobs.runClaimed(claimed, {});
    return true;
  };
  const drain = async () => {
    for (let tries = 0; tries < 30; tries += 1) if (!(await runNext())) return;
    throw new Error("The jobs never ran out");
  };
  return {
    rpc,
    id,
    thread,
    drain,
    send: async (message: string) =>
      receiveCustomerMessage(
        { ...feature.context, channel: noCustomerChannel },
        { representativeId: id, channel: fakeChannel, externalId: number, message },
      ),
    /** Lets `ms` pass, then runs what came due. */
    wait: async (ms: number) => {
      timer.advance(ms);
      await drain();
    },
    pages: async (cause: string) => (await rpc.pages.list()).filter((page) => page.cause === cause),
    notes: async () => (await thread()).messages.filter((message) => message.text === stallNote),
    assignment: async () => {
      const [row] = await getTestDb().select().from(botAssignment);
      return row!;
    },
  };
}

describe("an Assignment from a Representative that is overdue", () => {
  it("sets the flag, Pages the owner and sends the Customer one holding note", async () => {
    const world = await serving([handsOff(), quiet()]);
    await world.send("I want a refund");
    await world.drain();
    expect((await world.assignment()).overdueAt).toBeNull();

    await world.wait(29 * minute);
    expect((await world.assignment()).overdueAt).toBeNull();
    expect(await world.notes()).toEqual([]);

    await world.wait(2 * minute);

    expect((await world.assignment()).overdueAt).not.toBeNull();
    expect(await world.pages("assignment_overdue")).toHaveLength(1);
    expect(await world.notes()).toHaveLength(1);
    // Once: nothing more comes of it later.
    await world.wait(120 * minute);
    expect(await world.pages("assignment_overdue")).toHaveLength(1);
    expect(await world.notes()).toHaveLength(1);
  });

  it("does none of it when the Assignment ends in time", async () => {
    const world = await serving([handsOff(), quiet(), quiet()], [finishes, quiet]);
    await world.send("I want a refund");
    await world.drain();
    expect((await world.assignment()).status).toBe("done");

    await world.wait(120 * minute);

    expect((await world.assignment()).overdueAt).toBeNull();
    expect(await world.pages("assignment_overdue")).toEqual([]);
    expect(await world.notes()).toEqual([]);
  });

  it("goes by the due time the owner set for the Representative", async () => {
    const world = await serving([handsOff(), quiet()]);
    const edited = await world.rpc.representative.setAssignmentDue({ id: world.id, minutes: 10 });
    expect(edited.assignmentDueMinutes).toBe(10);
    await expect(
      world.rpc.representative.setAssignmentDue({ id: world.id, minutes: 0 }),
    ).rejects.toThrow();
    await world.send("I want a refund");
    await world.drain();

    await world.wait(11 * minute);

    expect((await world.assignment()).overdueAt).not.toBeNull();
    expect(await world.pages("assignment_overdue")).toHaveLength(1);
  });

  it("Pages the owner but sends nothing on a thread the owner holds", async () => {
    const world = await serving([handsOff(), quiet()]);
    await world.send("I want a refund");
    await world.drain();
    await world.rpc.representative.threadTakeOver({ id: (await world.thread()).id });

    await world.wait(31 * minute);

    expect(await world.pages("assignment_overdue")).toHaveLength(1);
    expect((await world.pages("assignment_overdue"))[0]!.text).toContain(
      "has not been sent a note",
    );
    expect(await world.notes()).toEqual([]);
  });
});

describe("a thread the owner holds", () => {
  it("Pages the owner once a Customer has waited 2 hours, and stays with the owner", async () => {
    const world = await serving([quiet()]);
    await world.send("Hello");
    await world.drain();
    await world.rpc.representative.threadTakeOver({ id: (await world.thread()).id });
    await world.send("Is anyone there?");

    await world.wait(119 * minute);
    expect(await world.pages("owner_wait")).toEqual([]);
    await world.wait(2 * minute);

    expect(await world.pages("owner_wait")).toHaveLength(1);
    expect((await world.thread()).holder).toBe("owner");
  });

  it("Pages once for a Customer who writes again while they wait", async () => {
    const world = await serving([quiet()]);
    await world.send("Hello");
    await world.drain();
    await world.rpc.representative.threadTakeOver({ id: (await world.thread()).id });
    await world.send("Is anyone there?");
    await world.wait(60 * minute);
    await world.send("Hello?");

    await world.wait(180 * minute);

    expect(await world.pages("owner_wait")).toHaveLength(1);
  });

  it("doesn't Page for a Customer the owner has answered", async () => {
    const world = await serving([quiet()]);
    await world.send("Hello");
    await world.drain();
    const { id } = await world.thread();
    await world.rpc.representative.threadTakeOver({ id });
    await world.send("Is anyone there?");
    await world.wait(60 * minute);
    await world.rpc.representative.threadSend({ id, text: "Yes, here." });

    await world.wait(180 * minute);

    expect(await world.pages("owner_wait")).toEqual([]);
  });

  it("doesn't Page for a Customer waiting after the owner handed the thread back", async () => {
    const world = await serving([quiet(), quiet()]);
    await world.send("Hello");
    await world.drain();
    const { id } = await world.thread();
    await world.rpc.representative.threadTakeOver({ id });
    await world.send("Is anyone there?");
    await world.rpc.representative.threadHandBack({ id });

    await world.wait(180 * minute);

    expect(await world.pages("owner_wait")).toEqual([]);
  });
});

describe("a hand-off from a Representative with no Bot", () => {
  it("Pages the owner each time", async () => {
    const world = await serving([handsOff(), quiet(), handsOff(), quiet()], [quiet], false);
    await world.send("I want a refund");
    await world.drain();
    expect(await world.pages("hand_off_no_bot")).toHaveLength(1);

    await world.send("Hello? My refund?");
    await world.drain();

    expect(await world.pages("hand_off_no_bot")).toHaveLength(2);
  });

  it("Pages when code hands off at the end of a Turn", async () => {
    const world = await serving([refused(), refused(), quiet()], [quiet], false);
    await world.send("What does it cost?");
    await world.drain();

    expect(await world.pages("hand_off_no_bot")).toHaveLength(1);
  });

  it("Pages once when the Model asks and code then hands off in the same Turn", async () => {
    const world = await serving([handsOff(), refused(), refused(), quiet()], [quiet], false);
    await world.send("What does it cost?");
    await world.drain();

    expect(await world.pages("hand_off_no_bot")).toHaveLength(1);
  });

  it("Pages nobody when the Representative has a Bot", async () => {
    const world = await serving([handsOff(), quiet()]);
    await world.send("I want a refund");
    await world.drain();

    expect(await world.pages("hand_off_no_bot")).toEqual([]);
  });
});
