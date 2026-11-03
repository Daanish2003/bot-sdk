import type { AnyTextAdapter } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner, PermanentJobError } from "@botsdk/bot/runner/internal";
import { botAssignment, job, usage } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { representative } from "../src";
import { representativeRelease, representativeTestResult } from "../src/server/db/schema";
import { transcriptOf } from "../src/server/test-checks";
import type { Draft } from "../src/shared/contract";

/*
 * A draft's scripted test conversations and the gate on approval (ticket #1192), through the
 * owner's API with a fake Model on real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];
type Conversation = Draft["tests"][number];

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const replies = (text: string) => round(toolCall({ name: "reply", input: { text } }));
const handsOff = () =>
  round(
    toolCall({
      name: "hand_to_bot",
      input: { title: "A refund", instructions: "They want a refund." },
    }),
  );
const quiet = () => round();

/**
 * An owner with the feature on, a Computer configured and a runner running. `script` maps what a
 * test Customer says to the Model's rounds for that conversation, so concurrent conversations
 * never take each other's rounds. `held` holds every Model call until it resolves.
 */
async function instance(
  script: Record<string, Round[]>,
  held?: Promise<void>,
  /** Runs at the end of each Model call, before its tools. */
  afterCall?: () => Promise<void>,
) {
  const fakes = new Map(
    Object.entries(script).map(([message, rounds]) => [message, createFakeAdapter({ rounds })]),
  );
  const entered: string[] = [];
  const adapter: AnyTextAdapter = {
    ...createFakeAdapter({ rounds: [] }).adapter,
    chatStream: async function* (options) {
      const sent = JSON.stringify(options.messages[0]?.content);
      const message = [...fakes.keys()].find((key) => sent.includes(key));
      entered.push(message ?? "");
      await held;
      if (!message) throw new Error("No script for this Customer message");
      yield* fakes.get(message)!.adapter.chatStream(options);
      await afterCall?.();
    },
  };
  const botFake = createFakeAdapter({ rounds: Array.from({ length: 20 }, () => quiet()) });
  const computer = fakeComputerProvider();
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
    adapterFor: (id) => (id === botModel ? botFake.adapter : adapter),
    memory: false,
    computer: computer.provider,
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
  return { fakes, entered, computer, deps, user, rpc: chatRpc({ user, deps }) };
}

type Rpc = Awaited<ReturnType<typeof instance>>["rpc"];

/** A Representative with job text, and `tests` on its draft. */
async function draftWith(
  rpc: Rpc,
  tests: Conversation[],
  extra: Partial<Draft> = {},
  botId?: string,
) {
  const { id } = await rpc.representative.create({ name: "Front desk", botId });
  await rpc.representative.updateDraft({
    id,
    draft: { jobText: "Answer questions.", model, tests, ...extra },
  });
  return id;
}

const opens: Conversation = {
  name: "Opening hours",
  message: "When do you open?",
  expect: [{ kind: "replied" }, { kind: "said", text: "nine" }],
};
const refund: Conversation = {
  name: "Refund request",
  message: "I want a refund",
  expect: [{ kind: "handed_off" }],
};

/** Waits until no test of the draft is queued or running: a failure shows before the others end. */
const finished = async (rpc: Rpc, id: string) => {
  await expect
    .poll(async () => {
      const { tests, testStatus } = await rpc.representative.get({ id });
      return (
        tests.length > 0 &&
        tests.every((test) => test.status !== "queued" && test.status !== "running") &&
        testStatus
      );
    }, poll)
    .toMatch(/^(passed|failed)$/);
  return rpc.representative.get({ id });
};

describe("writing test conversations", () => {
  it("pins them in the Release, as the draft had them", async () => {
    const { rpc } = await instance({});
    const id = await draftWith(rpc, [opens, refund]);

    const stored = await rpc.representative.get({ id });
    expect(stored.draft.tests).toEqual([opens, refund]);
    const release = await rpc.representative.approve({
      id,
      overrideReason: "Approving before the tests have run",
    });
    expect(release.content.tests).toEqual([opens, refund]);

    await rpc.representative.updateDraft({ id, draft: { tests: [] } });
    const [pinned] = await getTestDb()
      .select()
      .from(representativeRelease)
      .where(eq(representativeRelease.id, release.id));
    expect(pinned!.content.tests).toEqual([opens, refund]);
  });

  it("refuses an expectation off the list, and a test with none", async () => {
    const { rpc } = await instance({});
    const id = await draftWith(rpc, []);

    await expect(
      rpc.representative.updateDraft({
        id,
        draft: { tests: [{ ...opens, expect: [{ kind: "judged_well" }] } as never] },
      }),
    ).rejects.toThrow();
    await expect(
      rpc.representative.updateDraft({ id, draft: { tests: [{ ...opens, expect: [] }] } }),
    ).rejects.toThrow();
  });

  it("approves a draft with no test conversations as before: nothing can fail", async () => {
    const { rpc } = await instance({});
    const id = await draftWith(rpc, []);

    expect((await rpc.representative.get({ id })).testStatus).toBe("none");
    expect((await rpc.representative.approve({ id })).number).toBe(1);
  });
});

describe("running them", () => {
  it("plays each conversation on the draft and has code check what was said and done", async () => {
    const { entered, deps, rpc } = await instance({
      [opens.message]: [replies("We open at nine."), quiet()],
      [refund.message]: [handsOff(), quiet()],
    });
    const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
    const id = await draftWith(rpc, [opens, refund], {}, botId);
    // The live Release is another text: a test runs on the draft.
    await rpc.representative.updateDraft({ id, draft: { jobText: "The draft's job." } });

    const queued = await rpc.representative.runTests({ id });
    expect(queued.testStatus).toBe("running");
    const done = await finished(rpc, id);

    expect(done.testStatus).toBe("passed");
    expect(done.tests.map((test) => [test.name, test.status])).toEqual([
      ["Opening hours", "passed"],
      ["Refund request", "passed"],
    ]);
    expect(done.tests[0]?.transcript).toEqual(
      expect.arrayContaining([
        { role: "customer", text: "When do you open?" },
        expect.objectContaining({ role: "representative", text: expect.stringContaining("nine") }),
      ]),
    );
    expect(done.tests[0]?.checks.map((check) => check.passed)).toEqual([true, true]);
    expect(entered).toHaveLength(4);
    void deps;
  });

  it("reaches nothing real: a hand-off opens no Assignment, and nothing is delivered", async () => {
    const { computer, rpc } = await instance({ [refund.message]: [handsOff(), quiet()] });
    const { id: botId } = await rpc.bots.create({ name: "Clerk", model: botModel });
    const id = await draftWith(rpc, [refund], {}, botId);

    await rpc.representative.runTests({ id });
    const done = await finished(rpc, id);

    expect(done.testStatus).toBe("passed");
    expect(
      await getTestDb().select().from(botAssignment).where(eq(botAssignment.assignedBotId, botId)),
    ).toEqual([]);
    expect(computer.calls).toEqual([]);
  });

  it("fails a test whose expectation is broken, with what code found", async () => {
    const { rpc } = await instance({
      [opens.message]: [replies("We open at ten."), quiet()],
      [refund.message]: [replies("Sorry, no."), quiet()],
      "Is it ten today?": [replies("Yes, we open at ten."), quiet()],
    });
    const forbidden: Conversation = {
      ...opens,
      message: "Is it ten today?",
      name: "Never says ten",
      expect: [{ kind: "not_said", text: "TEN" }, { kind: "not_handed_off" }],
    };
    const id = await draftWith(rpc, [opens, refund, forbidden]);

    await rpc.representative.runTests({ id });
    const done = await finished(rpc, id);

    expect(done.testStatus).toBe("failed");
    const [said, handed, never] = done.tests;
    expect(said).toMatchObject({ status: "failed" });
    expect(said?.checks.map((check) => check.passed)).toEqual([true, false]);
    expect(handed?.checks[0]).toMatchObject({ passed: false });
    expect(never).toMatchObject({ status: "failed" });
    expect(never?.checks.map((check) => check.passed)).toEqual([false, true]);
  });

  it("doesn't count a reply the tool refused as sent", async () => {
    const { rpc } = await instance({
      [opens.message]: [replies(""), quiet()],
    });
    const id = await draftWith(rpc, [{ ...opens, expect: [{ kind: "replied" }] }]);

    await rpc.representative.runTests({ id });
    const done = await finished(rpc, id);

    expect(done.tests[0]).toMatchObject({
      status: "failed",
      checks: [{ passed: false, detail: "It sent the Customer nothing." }],
    });
  });

  it("fails a hand-off expectation when the Release lists no hand-off tool", async () => {
    const { rpc } = await instance({ [refund.message]: [handsOff(), quiet()] });
    const id = await draftWith(rpc, [refund], { tools: ["reply"] });

    await rpc.representative.runTests({ id });
    const done = await finished(rpc, id);

    expect(done.tests[0]).toMatchObject({ status: "failed" });
  });

  it("records the owner's Model calls as representative usage on their Quota", async () => {
    const { user, rpc } = await instance({
      [opens.message]: [replies("We open at nine."), quiet()],
    });
    const id = await draftWith(rpc, [opens]);

    await rpc.representative.runTests({ id });
    await finished(rpc, id);

    const rows = await getTestDb()
      .select({ kind: usage.kind })
      .from(usage)
      .where(eq(usage.userId, user.id));
    expect(rows.map((row) => row.kind)).toEqual(["representative", "representative"]);
  });

  it("reports a Model that fails as an error, which blocks approval too", async () => {
    const { rpc } = await instance({ [opens.message]: [] });
    const id = await draftWith(rpc, [opens]);

    await rpc.representative.runTests({ id });
    const done = await finished(rpc, id);

    expect(done.tests[0]).toMatchObject({ status: "error", error: expect.any(String) });
    expect(done.testStatus).toBe("failed");
  });

  it("stops calling the Model once the draft has changed under a running conversation", async () => {
    let change = async () => {};
    const { rpc, entered } = await instance(
      { [opens.message]: [replies("One."), replies("Two."), replies("Three."), quiet()] },
      undefined,
      () => change(),
    );
    const id = await draftWith(rpc, [opens]);
    change = async () => {
      change = async () => {};
      await rpc.representative.updateDraft({ id, draft: { jobText: "Something else." } });
    };

    await rpc.representative.runTests({ id });
    await expect.poll(() => entered.length, poll).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(entered).toHaveLength(1);
    // Its row is gone, so it can't count if the draft comes back.
    expect(await getTestDb().select().from(representativeTestResult)).toEqual([]);
    expect((await rpc.representative.get({ id })).testStatus).toBe("notRun");
  });

  it("stops calling the Model once a new run has replaced a running conversation", async () => {
    let change = async () => {};
    const { rpc, entered } = await instance(
      { [opens.message]: [replies("One."), replies("Two."), replies("Three."), quiet()] },
      undefined,
      () => change(),
    );
    const id = await draftWith(rpc, [opens]);
    change = async () => {
      change = async () => {};
      await getTestDb().delete(representativeTestResult);
    };

    await rpc.representative.runTests({ id });
    await expect.poll(() => entered.length, poll).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(entered).toHaveLength(1);
  });

  it("ends in an error when its job ends without a result", async () => {
    const { rpc, deps } = await instance({
      [opens.message]: [replies("We open at nine."), quiet()],
    });
    const id = await draftWith(rpc, [opens], { model: null });
    const { models } = deps.parts.features[0]!.context;
    vi.spyOn(models, "listAvailableModels").mockRejectedValueOnce(
      new PermanentJobError("The database is on fire"),
    );

    await rpc.representative.runTests({ id });
    const done = await finished(rpc, id);

    expect(done.tests[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("on fire"),
    });
    expect(done.testStatus).toBe("failed");
  });

  it("doesn't read as failed while a failed attempt waits to be retried", async () => {
    const { rpc, deps } = await instance({
      [opens.message]: [replies("We open at nine."), quiet()],
    });
    const id = await draftWith(rpc, [opens]);
    const { representativeLoop } = deps.parts.features[0]!.context;
    vi.spyOn(representativeLoop, "run").mockRejectedValueOnce(new Error("A blip"));

    await rpc.representative.runTests({ id });
    await expect
      .poll(async () => {
        const [row] = await getTestDb()
          .select({ attempts: job.attempts, status: job.status })
          .from(job)
          .where(eq(job.name, "representative.test"));
        return row?.attempts === 1 && row.status === "queued";
      }, poll)
      .toBe(true);

    const view = await rpc.representative.get({ id });
    expect(view.tests[0]).toMatchObject({ status: "running", error: null });
    expect(view.testStatus).toBe("running");
  });

  it("is the owner's alone", async () => {
    const { deps, rpc } = await instance({});
    const id = await draftWith(rpc, [opens]);
    const stranger = chatRpc({ user: await insertUser(), deps });

    await expect(stranger.representative.runTests({ id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("approving after tests", () => {
  const passing = () => instance({ [opens.message]: [replies("We open at nine."), quiet()] });

  it("approves once every test has passed, and logs no override", async () => {
    const { rpc } = await passing();
    const id = await draftWith(rpc, [opens]);
    await rpc.representative.runTests({ id });
    await finished(rpc, id);

    const release = await rpc.representative.approve({ id });

    expect(release).toMatchObject({ number: 1, overrideReason: null });
  });

  it("refuses while tests haven't been run, and makes no Release", async () => {
    const { rpc } = await passing();
    const id = await draftWith(rpc, [opens]);

    await expect(rpc.representative.approve({ id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { code: "error.representativeTestsUnfinished" },
    });
    expect((await rpc.representative.get({ id })).releases).toEqual([]);
  });

  it("refuses while tests are still running", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { rpc } = await instance(
      { [opens.message]: [replies("We open at nine."), quiet()] },
      held,
    );
    const id = await draftWith(rpc, [opens]);
    await rpc.representative.runTests({ id });

    await expect(rpc.representative.approve({ id })).rejects.toMatchObject({
      data: { code: "error.representativeTestsUnfinished" },
    });
    release();
    await finished(rpc, id);
    expect((await rpc.representative.approve({ id })).number).toBe(1);
  });

  it("refuses while a test has failed", async () => {
    const { rpc } = await instance({ [opens.message]: [replies("We open at ten."), quiet()] });
    const id = await draftWith(rpc, [opens]);
    await rpc.representative.runTests({ id });
    await finished(rpc, id);

    await expect(rpc.representative.approve({ id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { code: "error.representativeTestsFailed" },
    });
    expect((await rpc.representative.get({ id })).releases).toEqual([]);
  });

  it("stops counting earlier results once the draft changes, whichever field", async () => {
    const { rpc } = await passing();
    const id = await draftWith(rpc, [opens]);
    await rpc.representative.runTests({ id });
    await finished(rpc, id);

    const changed = await rpc.representative.updateDraft({ id, draft: { jobText: "Be brief." } });

    expect(changed.testStatus).toBe("notRun");
    expect(changed.tests).toEqual([]);
    await expect(rpc.representative.approve({ id })).rejects.toMatchObject({
      data: { code: "error.representativeTestsUnfinished" },
    });

    // Changing the test conversations themselves voids them too.
    await rpc.representative.runTests({ id });
    await finished(rpc, id);
    const edited = await rpc.representative.updateDraft({
      id,
      draft: { tests: [{ ...opens, name: "Renamed" }] },
    });
    expect(edited.testStatus).toBe("notRun");
  });

  it("approves anyway with a reason, and logs the reason with the Release", async () => {
    const { rpc } = await instance({ [opens.message]: [replies("We open at ten."), quiet()] });
    const id = await draftWith(rpc, [opens]);
    await rpc.representative.runTests({ id });
    await finished(rpc, id);

    await expect(rpc.representative.approve({ id, overrideReason: "   " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { code: "error.representativeOverrideReason" },
    });
    const release = await rpc.representative.approve({
      id,
      overrideReason: "  The hours changed today.  ",
    });

    expect(release).toMatchObject({ number: 1, overrideReason: "The hours changed today." });
    const view = await rpc.representative.get({ id });
    expect(view.liveRelease?.overrideReason).toBe("The hours changed today.");
    expect(view.releases[0]?.overrideReason).toBe("The hours changed today.");
    const [row] = await getTestDb()
      .select()
      .from(representativeRelease)
      .where(eq(representativeRelease.id, release.id));
    expect(row!.overrideReason).toBe("The hours changed today.");
  });

  it("logs no reason when the tests passed and one is sent anyway", async () => {
    const { rpc } = await passing();
    const id = await draftWith(rpc, [opens]);
    await rpc.representative.runTests({ id });
    await finished(rpc, id);

    const release = await rpc.representative.approve({ id, overrideReason: "Just in case" });

    expect(release.overrideReason).toBeNull();
  });

  it("replaces earlier results when the tests run again", async () => {
    const { rpc } = await instance({
      [opens.message]: [replies("We open at ten."), quiet(), replies("We open at nine."), quiet()],
    });
    const id = await draftWith(rpc, [opens]);
    await rpc.representative.runTests({ id });
    expect((await finished(rpc, id)).testStatus).toBe("failed");

    await rpc.representative.runTests({ id });
    const again = await finished(rpc, id);

    expect(again.tests).toHaveLength(1);
    expect(again.testStatus).toBe("passed");
  });
});

describe("the transcript the owner reads", () => {
  const replyCall = (id: string, text: string) => ({
    role: "assistant" as const,
    content: null,
    toolCalls: [
      {
        id,
        type: "function" as const,
        function: { name: "reply", arguments: JSON.stringify({ text }) },
      },
    ],
  });

  it("shows a reply as sent only when the tool answered that it was", () => {
    expect(
      transcriptOf("Hi", [
        replyCall("sent", "Hello."),
        { role: "tool", toolCallId: "sent", content: JSON.stringify({ sent: true }) },
      ]),
    ).toEqual([
      { role: "customer", text: "Hi" },
      { role: "representative", text: "Hello." },
    ]);
  });

  it("shows a reply the tool refused as a tool call, with its answer", () => {
    expect(
      transcriptOf("Hi", [
        replyCall("refused", "Hello."),
        { role: "tool", toolCallId: "refused", content: JSON.stringify({ error: "No." }) },
      ]),
    ).toEqual([
      { role: "customer", text: "Hi" },
      { role: "tool", text: `reply ${JSON.stringify({ text: "Hello." })}` },
      { role: "tool", text: JSON.stringify({ error: "No." }) },
    ]);
  });

  it("shows a reply never answered as a tool call", () => {
    expect(transcriptOf("Hi", [replyCall("lost", "Hello.")])).toEqual([
      { role: "customer", text: "Hi" },
      { role: "tool", text: `reply ${JSON.stringify({ text: "Hello." })}` },
    ]);
  });
});
