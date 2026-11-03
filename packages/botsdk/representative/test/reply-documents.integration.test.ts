import type { AnyTextAdapter } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { startTestCustomerTurn, testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { representativeThread, representativeThreadMessage } from "../src/server/db/schema";
import type { Expectation } from "../src/shared/contract";

/*
 * A reply citing a quote from a Release's document (ticket #1266): from a fake Channel through a
 * Representative Turn, with a fake Model on real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const cites = (name: string, quote: string) =>
  round(
    toolCall({
      name: "reply",
      input: {
        text: "Here you go.",
        kind: "answer",
        sources: [{ type: "document", name, quote }],
      },
    }),
  );

const warranty = "Two years on every kettle, parts and labour.";
const returns = "Returns are free within thirty days.";

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

/** An owner with a runner running, and a fake Model that can be held before its first call. */
async function instance(rounds: Round[], held?: Promise<void>) {
  const fake = createFakeAdapter({ rounds });
  const entered: unknown[] = [];
  const adapter: AnyTextAdapter = {
    ...fake.adapter,
    chatStream: async function* (options) {
      entered.push(options);
      if (entered.length === 1) await held;
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
  const rpc = chatRpc({ user, deps });
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({ id, draft: { jobText: "Answer questions.", model } });
  const upload = (name: string, text: string) =>
    rpc.representative.documentUpload({ id, file: new File([text], name) });
  const remove = async (name: string) => {
    const { draft } = await rpc.representative.get({ id });
    const found = draft.documents.find((document) => document.name === name)!;
    await rpc.representative.documentRemove({ id, documentId: found.id });
  };
  const sent = () =>
    getTestDb()
      .select({
        text: representativeThreadMessage.text,
        sources: representativeThreadMessage.sources,
      })
      .from(representativeThreadMessage)
      .innerJoin(
        representativeThread,
        eq(representativeThread.id, representativeThreadMessage.threadId),
      )
      .where(
        and(
          eq(representativeThread.representativeId, id),
          eq(representativeThreadMessage.author, "representative"),
        ),
      );
  return { fake, entered, deps, rpc, id, upload, remove, sent };
}

/** What the tools answered in the Model's call. */
const answersIn = (call: { messages: unknown } | undefined) =>
  ((call?.messages ?? []) as Array<{ role: string; content: unknown }>)
    .filter((entry) => entry.role === "tool")
    .map((entry) => String(entry.content));

describe("a reply citing a document quote", () => {
  it("goes through when the quote is exact, and stores its source", async () => {
    const { deps, rpc, id, upload, sent } = await instance([
      cites("warranty.md", "Two years on every kettle"),
      quiet(),
    ]);
    await upload("warranty.md", warranty);
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });

    await testCustomerTurn(deps, { representativeId: id, message: "Warranty?" });

    expect(await sent()).toEqual([
      {
        text: "Here you go.",
        sources: [{ type: "document", name: "warranty.md", quote: "Two years on every kettle" }],
      },
    ]);
  });

  it("refuses an invented quote with the reason, and sends nothing", async () => {
    const { deps, fake, rpc, id, upload, sent } = await instance([
      cites("warranty.md", "Three years on every kettle"),
      quiet(),
    ]);
    await upload("warranty.md", warranty);
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });

    await testCustomerTurn(deps, { representativeId: id, message: "Warranty?" });

    expect(await sent()).toEqual([]);
    expect(answersIn(fake.calls[1])[0]).toMatch(/Nothing was sent.*warranty\.md.*exact quote/);
  });

  it("refuses a quote from a document the Release does not hold, though an earlier Release or the draft did", async () => {
    const { deps, fake, rpc, id, upload, remove, sent } = await instance([
      cites("warranty.md", "Two years on every kettle"),
      cites("draft-only.md", "Only in the draft"),
      cites("returns.md", "Returns are free"),
      quiet(),
    ]);
    await upload("warranty.md", warranty);
    await rpc.representative.approve({ id });
    await remove("warranty.md");
    await upload("returns.md", returns);
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    // Only the draft holds this one.
    await upload("draft-only.md", "Only in the draft.");

    await testCustomerTurn(deps, { representativeId: id, message: "Warranty?" });

    expect(answersIn(fake.calls[1])[0]).toMatch(/Nothing was sent.*warranty\.md/);
    expect(answersIn(fake.calls[2])[1]).toMatch(/Nothing was sent.*draft-only\.md/);
    expect((await sent()).map((message) => message.sources)).toEqual([
      [{ type: "document", name: "returns.md", quote: "Returns are free" }],
    ]);
  });

  it("refuses a document source when the Release has no snapshot", async () => {
    const { deps, fake, rpc, id, upload, sent } = await instance([
      cites("warranty.md", "Two years"),
      quiet(),
    ]);
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    // The draft holds one now; the live Release holds none.
    await upload("warranty.md", warranty);

    await testCustomerTurn(deps, { representativeId: id, message: "Warranty?" });

    expect(await sent()).toEqual([]);
    expect(answersIn(fake.calls[1])[0]).toMatch(/Nothing was sent/);
  });

  it("checks a running Turn against the Release it started on, across a rollback", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, entered, fake, rpc, id, upload, remove, sent } = await instance(
      [
        cites("warranty.md", "Two years on every kettle"),
        cites("returns.md", "Returns are free"),
        quiet(),
      ],
      held,
    );
    await upload("warranty.md", warranty);
    const first = await rpc.representative.approve({ id });
    await remove("warranty.md");
    await upload("returns.md", returns);
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });

    const running = await startTestCustomerTurn(deps, { representativeId: id, message: "Hi" });
    await expect.poll(() => entered.length, poll).toBe(1);
    await rpc.representative.rollback({ id, releaseId: first.id });
    release();
    await expect
      .poll(async () => (await deps.runner.status(running.jobId))?.status, poll)
      .toBe("succeeded");

    // It started on the second Release: its warranty quote is refused, its returns quote goes through.
    expect(answersIn(fake.calls[1])[0]).toMatch(/Nothing was sent/);
    expect((await sent()).map((message) => message.sources)).toEqual([
      [{ type: "document", name: "returns.md", quote: "Returns are free" }],
    ]);
  });
});

describe("a test conversation citing a document quote", () => {
  async function tested(rounds: Round[], expectations: Expectation[] = [{ kind: "replied" }]) {
    const { fake, rpc, id, upload } = await instance(rounds);
    await upload("warranty.md", warranty);
    await rpc.representative.updateDraft({
      id,
      draft: {
        jobText: "Answer questions.",
        model,
        tests: [{ name: "Warranty", message: "Warranty?", expect: expectations }],
      },
    });
    await rpc.representative.runTests({ id });
    await expect
      .poll(async () => {
        const { tests } = await rpc.representative.get({ id });
        return tests.every((test) => test.status !== "queued" && test.status !== "running");
      }, poll)
      .toBe(true);
    const { tests } = await rpc.representative.get({ id });
    return { result: tests[0]!, fake };
  }

  it("checks quotes against the draft's documents", async () => {
    const { result } = await tested([cites("warranty.md", "Two years on every kettle"), quiet()]);

    expect(result.status).toBe("passed");
  });

  it("refuses an invented quote there too", async () => {
    const { result, fake } = await tested([cites("warranty.md", "Ten years"), quiet()]);

    expect(result.status).toBe("failed");
    expect(answersIn(fake.calls[1])[0]).toMatch(/Nothing was sent/);
  });

  it("passes cited for a named document, and fails it for another source", async () => {
    const { result } = await tested(
      [cites("warranty.md", "Two years on every kettle"), quiet()],
      [
        { kind: "cited" },
        { kind: "cited", source: { type: "document", name: "warranty.md" } },
        { kind: "cited", source: { type: "document", name: "returns.md" } },
        { kind: "cited", source: { type: "fact", key: "price.haircut" } },
      ],
    );

    expect(result.status).toBe("failed");
    expect(result.checks.map((check) => check.passed)).toEqual([true, true, false, false]);
    expect(result.checks[1]?.detail).toBe("It cited the document warranty.md.");
    expect(result.checks[2]?.detail).toBe(
      "It never cited the document returns.md. It cited the document warranty.md.",
    );
  });

  it("doesn't count a refused reply as cited", async () => {
    const { result } = await tested(
      [cites("warranty.md", "Ten years"), quiet()],
      [{ kind: "cited" }],
    );

    expect(result.checks).toMatchObject([{ passed: false, detail: "It cited no source." }]);
  });
});
