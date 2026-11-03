import type { AnyTextAdapter } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { usage } from "@botsdk/bot/storage";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { startTestCustomerTurn, testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { representativeRelease } from "../src/server/db/schema";
import { draftChanges } from "../src/server/representatives";

/*
 * Diffing a draft and rolling back a Release (ticket #1193), through the owner's API and the test
 * Customer entry point, with a fake Model on real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const promptOf = (call: { systemPrompts?: unknown } | undefined) =>
  JSON.stringify(call?.systemPrompts ?? []);

/** An owner with the feature on, a runner running, and a fake Model that can be held. */
async function instance(held?: Promise<void>) {
  const fake = createFakeAdapter({ rounds: [round(), round(), round(), round()] });
  const entered: unknown[] = [];
  const adapter: AnyTextAdapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options);
      await held;
      yield* fake.adapter.chatStream(options);
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
    features: [representative()],
    adapterFor: () => adapter,
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
  return { fake, entered, deps, user, rpc: chatRpc({ user, deps }) };
}

type Rpc = Awaited<ReturnType<typeof instance>>["rpc"];

/** A Representative with `texts.length` Releases, each approved from a draft of its text. */
async function released(rpc: Rpc, texts: string[]) {
  const { id } = await rpc.representative.create({ name: "Front desk" });
  const releases = [];
  for (const jobText of texts) {
    await rpc.representative.updateDraft({ id, draft: { jobText, model } });
    releases.push(await rpc.representative.approve({ id }));
  }
  return { id, releases };
}

const releaseRows = (representativeId: string) =>
  getTestDb()
    .select()
    .from(representativeRelease)
    .where(eq(representativeRelease.representativeId, representativeId))
    .orderBy(representativeRelease.number);

describe("the diff between a draft and the live Release", () => {
  it("is empty when the draft is what the live Release pinned", async () => {
    const { rpc } = await instance();
    const { id } = await released(rpc, ["Answer questions."]);

    expect(await rpc.representative.diff({ id })).toEqual({ liveReleaseNumber: 1, changes: [] });
  });

  it("shows a change to the job text and the Model, and only those", async () => {
    const { rpc } = await instance();
    const { id } = await released(rpc, ["Answer questions."]);
    await rpc.representative.updateDraft({
      id,
      draft: { jobText: "Answer anything.", model: "openai:gpt-5.4-mini" },
    });

    const { changes } = await rpc.representative.diff({ id });

    expect(changes).toEqual([
      {
        field: "jobText",
        name: null,
        before: JSON.stringify("Answer questions."),
        after: JSON.stringify("Answer anything."),
      },
      {
        field: "model",
        name: null,
        before: JSON.stringify(model),
        after: JSON.stringify("openai:gpt-5.4-mini"),
      },
    ]);
  });

  it("shows switches, Skills and tools added, removed and changed", async () => {
    const { rpc } = await instance();
    const { id } = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({
      id,
      draft: {
        jobText: "Answer",
        switches: { quotePrices: true, refunds: false },
        skills: [
          { name: "Refunds", text: "Within 30 days." },
          { name: "Greeting", text: "Say hello." },
        ],
        tools: ["reply", "hand_to_bot"],
      },
    });
    await rpc.representative.approve({ id });
    await rpc.representative.updateDraft({
      id,
      draft: {
        switches: { quotePrices: false, discounts: true },
        skills: [
          { name: "Refunds", text: "Within 14 days." },
          { name: "Shipping", text: "Ask the postcode." },
        ],
        tools: ["reply"],
      },
    });

    const { changes } = await rpc.representative.diff({ id });

    const of = (field: string) => changes.filter((change) => change.field === field);
    expect(of("switch")).toEqual([
      { field: "switch", name: "discounts", before: null, after: "true" },
      { field: "switch", name: "quotePrices", before: "true", after: "false" },
      { field: "switch", name: "refunds", before: "false", after: null },
    ]);
    expect(of("skill")).toEqual([
      {
        field: "skill",
        name: "Refunds",
        before: JSON.stringify("Within 30 days."),
        after: JSON.stringify("Within 14 days."),
      },
      { field: "skill", name: "Greeting", before: JSON.stringify("Say hello."), after: null },
      {
        field: "skill",
        name: "Shipping",
        before: null,
        after: JSON.stringify("Ask the postcode."),
      },
    ]);
    expect(of("tool")).toEqual([
      { field: "tool", name: "hand_to_bot", before: "true", after: null },
    ]);
    expect(of("jobText")).toEqual([]);
  });

  it("shows a changed test conversation by name, and ignores one both sides hold alike", () => {
    // Test conversations arrive on the draft with the test spec; the diff compares them by name.
    const base = { jobText: "x", switches: {}, skills: [], tools: [], model: null };
    const kept = { name: "Greets", turns: ["Hi"] };
    const live = {
      ...base,
      documentSnapshot: null,
      tests: [kept, { name: "Refunds", turns: ["a"] }],
    };
    const draft = { ...base, tests: [kept, { name: "Refunds", turns: ["b"] }, { name: "New" }] };

    const tests = draftChanges(draft as never, live as never).filter(
      (change) => change.field === "test",
    );

    expect(tests).toEqual([
      {
        field: "test",
        name: "Refunds",
        before: JSON.stringify({ name: "Refunds", turns: ["a"] }),
        after: JSON.stringify({ name: "Refunds", turns: ["b"] }),
      },
      { field: "test", name: "New", before: null, after: JSON.stringify({ name: "New" }) },
    ]);
  });

  it("shows a repeated Skill name without hiding a change", () => {
    const base = { jobText: "x", switches: {}, tools: [], model: null, tests: [] };
    const live = {
      ...base,
      documentSnapshot: null,
      skills: [
        { name: "A", text: "1" },
        { name: "A", text: "2" },
      ],
    };

    const changes = draftChanges({ ...base, skills: [{ name: "A", text: "1" }] }, live);

    // The second "A" is gone.
    expect(changes).toEqual([
      { field: "skill", name: "A (2)", before: JSON.stringify("2"), after: null },
    ]);
  });

  it("shows everything as new before the first Release", async () => {
    const { rpc } = await instance();
    const { id } = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer" } });

    const diff = await rpc.representative.diff({ id });

    expect(diff.liveReleaseNumber).toBeNull();
    expect(diff.changes.map((change) => change.field)).toEqual(["jobText", "tool", "tool"]);
    // Before a first Release, the live side has none: not the text "null".
    expect(diff.changes[0]).toMatchObject({ before: null, after: JSON.stringify("Answer") });
  });

  it("shows a Model chosen where the live Release named none, and the reverse, as none", () => {
    const base = { jobText: "x", switches: {}, skills: [], tools: [], tests: [] };
    const live = { ...base, model: null, documentSnapshot: null };
    const draft = { ...base, model };

    expect(draftChanges(draft, live)).toEqual([
      { field: "model", name: null, before: null, after: JSON.stringify(model) },
    ]);
    expect(draftChanges({ ...base, model: null }, { ...draft, documentSnapshot: null })).toEqual([
      { field: "model", name: null, before: JSON.stringify(model), after: null },
    ]);
  });

  it("keeps a repeated name's key from colliding with a real name", () => {
    const base = { jobText: "x", switches: {}, tools: [], model: null, tests: [] };
    const skills = [
      { name: "A", text: "1" },
      { name: "A", text: "2" },
      { name: "A (2)", text: "3" },
    ];
    const edited = [skills[0]!, { name: "A", text: "changed" }, skills[2]!];

    const changes = draftChanges(
      { ...base, skills: edited },
      { ...base, skills, documentSnapshot: null },
    );

    expect(changes).toEqual([
      {
        field: "skill",
        name: "A (2)",
        before: JSON.stringify("2"),
        after: JSON.stringify("changed"),
      },
    ]);
  });

  it("shows Skills and test conversations put in another order", () => {
    const base = { jobText: "x", switches: {}, tools: [], model: null };
    const first = { name: "First", text: "1" };
    const second = { name: "Second", text: "2" };
    const test = (name: string) => ({
      name,
      message: "Hi",
      expect: [{ kind: "replied" as const }],
    });

    const changes = draftChanges(
      { ...base, skills: [second, first], tests: [test("B"), test("A")] },
      { ...base, skills: [first, second], tests: [test("A"), test("B")], documentSnapshot: null },
    );

    expect(changes).toEqual([
      {
        field: "skill",
        name: null,
        before: JSON.stringify(["First", "Second"]),
        after: JSON.stringify(["Second", "First"]),
      },
      {
        field: "test",
        name: null,
        before: JSON.stringify(["A", "B"]),
        after: JSON.stringify(["B", "A"]),
      },
    ]);
  });

  it("shows no order change when a Skill is only added or removed", () => {
    const base = { jobText: "x", switches: {}, tools: [], model: null, tests: [] };
    const first = { name: "First", text: "1" };
    const second = { name: "Second", text: "2" };

    const changes = draftChanges(
      { ...base, skills: [second] },
      { ...base, skills: [first, second], documentSnapshot: null },
    );

    expect(changes.map((change) => change.name)).toEqual(["First"]);
  });

  it("can't be read for another owner's Representative", async () => {
    const { deps, rpc } = await instance();
    const { id } = await released(rpc, ["Answer"]);
    const stranger = chatRpc({ user: await insertUser(), deps });

    await expect(stranger.representative.diff({ id })).rejects.toMatchObject({
      code: "NOT_FOUND",
      data: { code: "error.representativeNotFound" },
    });
  });
});

describe("the Release history", () => {
  it("lists every Release with its number, newest first", async () => {
    const { rpc } = await instance();
    const { id } = await released(rpc, ["One", "Two", "Three"]);

    const { releases } = await rpc.representative.get({ id });

    expect(releases.map((release) => release.number)).toEqual([3, 2, 1]);
  });
});

describe("the Release history and the override reason", () => {
  it("lists each Release's logged override reason, and rolling back keeps every reason", async () => {
    const { rpc } = await instance();
    const { id, releases } = await released(rpc, ["One"]);
    // The quiet fake Model never replies, so this test fails and the next Release is an override.
    await rpc.representative.updateDraft({
      id,
      draft: {
        jobText: "Two",
        tests: [{ name: "Replies", message: "Hi", expect: [{ kind: "replied" }] }],
      },
    });
    await rpc.representative.runTests({ id });
    await expect
      .poll(async () => (await rpc.representative.get({ id })).testStatus, poll)
      .toBe("failed");
    const second = await rpc.representative.approve({
      id,
      overrideReason: "The fake Model can't reply.",
    });

    const history = (await rpc.representative.get({ id })).releases;
    expect(history.map(({ number, overrideReason }) => [number, overrideReason])).toEqual([
      [2, "The fake Model can't reply."],
      [1, null],
    ]);

    const back = await rpc.representative.rollback({ id, releaseId: releases[0]!.id });
    expect(back.releases.map((release) => release.overrideReason)).toEqual([
      "The fake Model can't reply.",
      null,
    ]);
    expect(back.liveRelease?.overrideReason).toBeNull();
    const forward = await rpc.representative.rollback({ id, releaseId: second.id });
    expect(forward.liveRelease?.overrideReason).toBe("The fake Model can't reply.");
  });
});

describe("rolling back", () => {
  it("repoints the live Release to an earlier one, changing no Release and not the draft", async () => {
    const { rpc } = await instance();
    const { id, releases } = await released(rpc, ["One", "Two", "Three"]);
    await rpc.representative.updateDraft({ id, draft: { jobText: "A draft in progress" } });
    const before = await releaseRows(id);

    const back = await rpc.representative.rollback({ id, releaseId: releases[0]!.id });

    expect(back).toMatchObject({
      liveReleaseNumber: 1,
      liveRelease: { id: releases[0]!.id, content: { jobText: "One" } },
      draft: { jobText: "A draft in progress" },
    });
    expect(await releaseRows(id)).toEqual(before);
    expect(back.releases.map((release) => release.number)).toEqual([3, 2, 1]);
    // And forward again, to a later Release.
    expect(
      (await rpc.representative.rollback({ id, releaseId: releases[2]!.id })).liveReleaseNumber,
    ).toBe(3);
  });

  it("makes no Model call and keeps on/off as it was", async () => {
    const { fake, rpc } = await instance();
    const { id, releases } = await released(rpc, ["One", "Two"]);
    await rpc.representative.setEnabled({ id, enabled: true });

    const back = await rpc.representative.rollback({ id, releaseId: releases[0]!.id });

    expect(back.enabled).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("refuses another Representative's Release, as a Release that doesn't exist", async () => {
    const { rpc } = await instance();
    const mine = await released(rpc, ["Mine"]);
    const other = await released(rpc, ["Other one", "Other two"]);

    const refused = { code: "NOT_FOUND", data: { code: "error.releaseNotFound" } };
    await expect(
      rpc.representative.rollback({ id: mine.id, releaseId: other.releases[0]!.id }),
    ).rejects.toMatchObject(refused);
    await expect(
      rpc.representative.rollback({
        id: mine.id,
        releaseId: "0198a000-0000-7000-8000-000000000000",
      }),
    ).rejects.toMatchObject(refused);
    expect((await rpc.representative.get({ id: mine.id })).liveRelease?.id).toBe(
      mine.releases[0]!.id,
    );
    expect((await rpc.representative.get({ id: other.id })).liveReleaseNumber).toBe(2);
  });

  it("can't be done by another owner, even to the owner's own Release", async () => {
    const { deps, rpc } = await instance();
    const { id, releases } = await released(rpc, ["One", "Two"]);
    const stranger = chatRpc({ user: await insertUser(), deps });

    await expect(
      stranger.representative.rollback({ id, releaseId: releases[0]!.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", data: { code: "error.representativeNotFound" } });
    expect((await rpc.representative.get({ id })).liveReleaseNumber).toBe(2);
  });

  it("gives the next Turn the Release rolled back to", async () => {
    const { fake, deps, rpc } = await instance();
    const { id, releases } = await released(rpc, ["Release one text.", "Release two text."]);
    await rpc.representative.setEnabled({ id, enabled: true });

    await rpc.representative.rollback({ id, releaseId: releases[0]!.id });
    await testCustomerTurn(deps, { representativeId: id, message: "Hi" });

    expect(promptOf(fake.calls[0])).toContain("Release one text.");
    expect(promptOf(fake.calls[0])).not.toContain("Release two text.");
  });

  it("lets a Turn running during it finish on its old Release, and the next Turn use the new one", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fake, entered, deps, user, rpc } = await instance(held);
    const { id, releases } = await released(rpc, ["Release one text.", "Release two text."]);
    await rpc.representative.setEnabled({ id, enabled: true });

    const running = await startTestCustomerTurn(deps, { representativeId: id, message: "First" });
    await expect.poll(() => entered.length, poll).toBe(1);
    await rpc.representative.rollback({ id, releaseId: releases[0]!.id });
    release();
    await expect
      .poll(async () => (await deps.runner.status(running.jobId))?.status, poll)
      .toBe("succeeded");
    await testCustomerTurn(deps, { representativeId: id, message: "Second" });

    expect(promptOf(fake.calls[0])).toContain("Release two text.");
    expect(promptOf(fake.calls[1])).toContain("Release one text.");
    expect(await getTestDb().select().from(usage).where(eq(usage.userId, user.id))).not.toEqual([]);
  });
});
