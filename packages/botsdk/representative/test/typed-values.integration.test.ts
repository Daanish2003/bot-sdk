import type { AnyTextAdapter } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { handOffMessage } from "../src/server/replies";
import { representative } from "../src";
import { representativeThread, representativeThreadMessage } from "../src/server/db/schema";

/*
 * The refusal of a price, phone number or link a Model typed (ticket #1268): from a fake Channel through a
 * Representative Turn, with a fake Model on real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const quiet = () => round();
const says = (text: string, kind: string, sources: object[] = []) =>
  round(toolCall({ name: "reply", input: { text, kind, sources } }));

const price = { key: "price.haircut", type: "money", topic: "Prices", value: "45 USD" } as const;

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

const doc = "prices.md";
const docText =
  "A haircut is $45 and a beard trim $20. Call +1 555 010 0199 or see https://shop.example/menu.";
const fact = { type: "fact", key: price.key };
const cite = (quote: string) => ({ type: "document", name: doc, quote });

/** Runs one Customer message against a Release holding the document and a fact. */
async function turnWith(rounds: Round[], message = "How much?") {
  const made = await instance(rounds);
  await made.rpc.representative.factAdd(price);
  await made.upload(doc, docText);
  await made.rpc.representative.approve({ id: made.id });
  await made.rpc.representative.setEnabled({ id: made.id, enabled: true });
  await testCustomerTurn(made.deps, { representativeId: made.id, message });
  return made;
}

const refusal = /Nothing was sent.*typed/;

describe("a typed price, phone number or link", () => {
  it("is refused, with a fact holding a different value", async () => {
    const { fake, sent } = await turnWith([says("A haircut is $5.", "answer", [fact]), quiet()]);

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(refusal);
  });

  it("is refused, with no such fact", async () => {
    const { fake, sent } = await turnWith([
      says("A haircut is $5.", "answer", [cite("a beard trim $20")]),
      quiet(),
    ]);

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(refusal);
  });

  it("is refused in a small_talk reply", async () => {
    const { fake, sent } = await turnWith([says("Hi! Cuts are 5 dollars.", "small_talk"), quiet()]);

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(refusal);
  });

  it.each([
    ["a phone number", "Call us on +1 555 010 0100."],
    ["a phone number in brackets", "Call (555) 010-0100."],
    ["a URL with a scheme", "See https://example.com/prices."],
    ["a bare domain", "See example.com for prices."],
    ["an amount with a currency name", "It costs 12 euros."],
    ["a currency code before the amount", "It costs USD 45."],
    ["a currency sign after the amount", "It costs 45$."],
    ["part of the fact's price", "A haircut is 5 USD."],
    ["a price that only starts like the quote's", "A beard trim is $2."],
    ["digits typed against a key", "A haircut is 1{{price.haircut}}."],
    ["a phone number the quote only starts with", "Call +1 555 010 019."],
  ])("refuses %s", async (_name, text) => {
    const { fake, sent } = await turnWith([
      says(text, "answer", [fact, cite("a beard trim $20"), cite("Call +1 555 010 0199")]),
      quiet(),
    ]);

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(refusal);
  });

  it("hands off after a second refusal", async () => {
    const { sent } = await turnWith([
      says("It is $5.", "small_talk"),
      says("It is $6.", "small_talk"),
    ]);

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
  });

  it("goes through when code inserted it from a fact", async () => {
    const { sent } = await turnWith([
      says("A haircut is {{price.haircut}}, no tip needed.", "answer", [fact]),
      quiet(),
    ]);

    expect((await sent()).map((message) => message.text)).toEqual([
      "A haircut is 45 USD, no tip needed.",
    ]);
  });

  it("goes through when the cited quote holds it, and is refused when the quote does not", async () => {
    const { fake, sent } = await turnWith([
      says("A beard trim is $20, and you can call +1 555 010 0199.", "answer", [
        cite("a beard trim $20"),
        cite("Call +1 555 010 0199"),
      ]),
      says("A beard trim is $20, see https://shop.example/menu.", "answer", [
        cite("a beard trim $20"),
      ]),
      quiet(),
    ]);

    expect((await sent()).map((message) => message.text)).toEqual([
      "A beard trim is $20, and you can call +1 555 010 0199.",
      handOffMessage,
    ]);
    expect(answersIn(fake.calls[2]).at(-1)).toMatch(refusal);
  });

  it("goes through when it is not money, a phone number or a link", async () => {
    const { sent } = await turnWith([
      says(
        "It takes 2 days, as in step 3 of 4, by 2026-11-04 or v1.2 at 10:30, order 1234567, on 11-04-2026.",
        "small_talk",
      ),
      quiet(),
    ]);

    expect((await sent()).map((message) => message.text)).toEqual([
      "It takes 2 days, as in step 3 of 4, by 2026-11-04 or v1.2 at 10:30, order 1234567, on 11-04-2026.",
    ]);
  });

  it("is not made a source by the Customer's own words", async () => {
    const { fake, sent } = await turnWith(
      [says("Yes, $5 and call +1 555 010 0100.", "small_talk"), quiet()],
      "Is it $5? Call me on +1 555 010 0100.",
    );

    expect((await sent()).map((message) => message.text)).toEqual([handOffMessage]);
    expect(answersIn(fake.calls[1])[0]).toMatch(refusal);
  });
});
