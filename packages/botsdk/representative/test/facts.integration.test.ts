import { describe, expect, it, vi } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { deleteUserData, exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { insertUser } from "@ai-chat/test-support/users";
import { representative } from "../src";

/*
 * An owner's Published facts (ticket #1258), through the owner API on real Postgres, with a clock
 * the test moves by hand: typed values, a key unique per owner, a log of every change, valid dates,
 * and facts staying outside a Release.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const day = 24 * 60 * 60 * 1000;

function instance() {
  const timer = fakeJobClock(new Date("2026-06-01T09:00:00Z"));
  const deps = createTestSdk({
    features: [representative()],
    clock: timer.clock.now,
    memory: false,
  });
  return { deps, timer };
}

async function owner(deps: TestDeps) {
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  return { user, rpc: chatRpc({ user, deps }) };
}

const price = { key: "price.haircut", type: "money", topic: "Prices", value: "45 USD" } as const;

describe("an owner's Published facts", () => {
  it("adds, edits and deletes a fact, listed by topic", async () => {
    const { deps } = instance();
    const { rpc } = await owner(deps);

    expect(await rpc.representative.factList()).toEqual([]);
    const added = await rpc.representative.factAdd(price);
    expect(added).toMatchObject({ ...price, value: "45 USD", validFrom: null, validUntil: null });
    await rpc.representative.factAdd({
      key: "hours.week",
      type: "hours",
      topic: "Hours",
      value: "Mon-Fri 09:00-17:00; Sat closed",
    });
    await rpc.representative.factAdd({
      key: "price.beard",
      type: "money",
      topic: "Prices",
      value: "20 USD",
    });
    expect((await rpc.representative.factList()).map((fact) => fact.key)).toEqual([
      "hours.week",
      "price.beard",
      "price.haircut",
    ]);

    const edited = await rpc.representative.factEdit({
      id: added.id,
      type: "money",
      topic: "Prices",
      value: "50.50 usd",
      validFrom: null,
      validUntil: null,
    });
    expect(edited).toMatchObject({ id: added.id, key: "price.haircut", value: "50.50 USD" });

    await rpc.representative.factDelete({ id: added.id });
    expect((await rpc.representative.factList()).map((fact) => fact.key)).toEqual([
      "hours.week",
      "price.beard",
    ]);
    await expect(rpc.representative.factDelete({ id: added.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it.each([
    ["text", "   ", "A fact about nothing"],
    ["money", "forty-five", "45 USD"],
    ["money", "45", "45 USD"],
    ["hours", "all day", "Mon-Fri 09:00-17:00"],
    ["hours", "Mon-Fri 17:00-09:00", "Mon-Fri 09:00-17:00"],
    ["hours", "Mon-Fri 09:00-17:00; Wed closed", "Mon-Tue 09:00-17:00; Wed closed"],
    ["money", "0045 USD", "45 USD"],
    ["url", "https:example.com", "https://example.com"],
    ["phone", "call us", "+1 (555) 000-1234"],
    ["url", "not a link", "https://example.com/book"],
    ["url", "javascript:alert(1)", "https://example.com/book"],
  ] as const)("refuses a %s value of %j and takes %j", async (type, bad, good) => {
    const { deps } = instance();
    const { rpc } = await owner(deps);

    await expect(
      rpc.representative.factAdd({
        key: "a.fact",
        type,
        topic: "General",
        value: bad,
        validFrom: null,
        validUntil: null,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await rpc.representative.factList()).toEqual([]);

    const added = await rpc.representative.factAdd({
      key: "a.fact",
      type,
      topic: "General",
      value: good,
    });
    await expect(
      rpc.representative.factEdit({
        id: added.id,
        type,
        topic: "General",
        value: bad,
        validFrom: null,
        validUntil: null,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await rpc.representative.factList())[0]?.value).toBe(added.value);
  });

  it("stores a phone number as digits with a plus", async () => {
    const { deps } = instance();
    const { rpc } = await owner(deps);

    const phone = await rpc.representative.factAdd({
      key: "phone.main",
      type: "phone",
      topic: "Contact",
      value: "+1 (555) 000-1234",
    });

    expect(phone.value).toBe("+15550001234");
  });

  it("keeps a key unique per owner, and shares nothing between owners", async () => {
    const { deps } = instance();
    const ada = await owner(deps);
    const bob = await owner(deps);

    await ada.rpc.representative.factAdd(price);
    await expect(
      ada.rpc.representative.factAdd({ ...price, value: "1 USD" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const theirs = await bob.rpc.representative.factAdd({ ...price, value: "99 USD" });

    expect((await ada.rpc.representative.factList()).map((fact) => fact.value)).toEqual(["45 USD"]);
    expect((await bob.rpc.representative.factList()).map((fact) => fact.value)).toEqual(["99 USD"]);
    // A fact of another owner's is not found, to edit or delete.
    const [mine] = await ada.rpc.representative.factList();
    await expect(
      ada.rpc.representative.factEdit({
        id: theirs.id,
        type: "text",
        topic: "x",
        value: "y",
        validFrom: null,
        validUntil: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ada.rpc.representative.factDelete({ id: theirs.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await bob.rpc.representative.factList())[0]?.value).toBe("99 USD");
    expect(mine?.value).toBe("45 USD");
  });

  it("logs every add, edit and delete with the old value, the new value and the time", async () => {
    const { deps, timer } = instance();
    const { rpc } = await owner(deps);
    const other = await owner(deps);

    const added = await rpc.representative.factAdd(price);
    timer.advance(60_000);
    await rpc.representative.factEdit({
      id: added.id,
      type: "money",
      topic: "Prices",
      value: "50 USD",
      validFrom: null,
      validUntil: null,
    });
    timer.advance(60_000);
    await rpc.representative.factDelete({ id: added.id });
    await other.rpc.representative.factAdd(price);

    const log = await rpc.representative.factLog();
    expect(log.map((entry) => [entry.action, entry.key])).toEqual([
      ["delete", "price.haircut"],
      ["edit", "price.haircut"],
      ["add", "price.haircut"],
    ]);
    expect(log.map((entry) => entry.old?.value ?? null)).toEqual(["50 USD", "45 USD", null]);
    expect(log.map((entry) => entry.new?.value ?? null)).toEqual([null, "50 USD", "45 USD"]);
    expect(log.map((entry) => entry.at.toISOString())).toEqual([
      "2026-06-01T09:02:00.000Z",
      "2026-06-01T09:01:00.000Z",
      "2026-06-01T09:00:00.000Z",
    ]);
  });

  it("logs nothing for an edit that changes nothing", async () => {
    const { deps } = instance();
    const { rpc } = await owner(deps);
    const added = await rpc.representative.factAdd(price);

    await rpc.representative.factEdit({
      id: added.id,
      ...price,
      validFrom: null,
      validUntil: null,
    });

    expect((await rpc.representative.factLog()).map((entry) => entry.action)).toEqual(["add"]);
  });

  it("puts a fact in effect only between its valid dates, and a seasonal value ends by itself", async () => {
    const { deps, timer } = instance();
    const { rpc } = await owner(deps);
    const now = timer.clock.now();

    await rpc.representative.factAdd({
      key: "price.summer",
      type: "money",
      topic: "Prices",
      value: "30 USD",
      validFrom: new Date(now.getTime() + 10 * day),
      validUntil: new Date(now.getTime() + 20 * day),
    });
    await rpc.representative.factAdd({ ...price });
    const inEffect = async () =>
      Object.fromEntries(
        (await rpc.representative.factList()).map((fact) => [fact.key, fact.inEffect]),
      );

    expect(await inEffect()).toEqual({ "price.haircut": true, "price.summer": false });
    timer.advance(10 * day);
    expect(await inEffect()).toEqual({ "price.haircut": true, "price.summer": true });
    timer.advance(10 * day - 1);
    expect((await inEffect())["price.summer"]).toBe(true);
    timer.advance(1);
    expect(await inEffect()).toEqual({ "price.haircut": true, "price.summer": false });
  });

  it("refuses valid dates that end before they start", async () => {
    const { deps, timer } = instance();
    const { rpc } = await owner(deps);
    const now = timer.clock.now();

    await expect(
      rpc.representative.factAdd({
        ...price,
        validFrom: new Date(now.getTime() + day),
        validUntil: new Date(now.getTime()),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("leaves facts as they are when a Release is rolled back, and holds none in a Release", async () => {
    const { deps } = instance();
    const { rpc } = await owner(deps);
    const { id } = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer.", model } });
    const first = await rpc.representative.approve({ id });
    const fact = await rpc.representative.factAdd(price);
    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer more." } });
    await rpc.representative.approve({ id });
    await rpc.representative.factEdit({
      id: fact.id,
      type: "money",
      topic: "Prices",
      value: "60 USD",
      validFrom: null,
      validUntil: null,
    });

    await rpc.representative.rollback({ id, releaseId: first.id });

    expect((await rpc.representative.factList()).map((each) => each.value)).toEqual(["60 USD"]);
    expect((await rpc.representative.factLog()).map((entry) => entry.action)).toEqual([
      "edit",
      "add",
    ]);
    expect(JSON.stringify(first)).not.toContain("price.haircut");
  });

  it("exports facts and their log, and deletes both with the account", async () => {
    const { deps } = instance();
    const { user, rpc } = await owner(deps);
    const added = await rpc.representative.factAdd(price);
    await rpc.representative.factEdit({
      id: added.id,
      type: "money",
      topic: "Prices",
      value: "50 USD",
      validFrom: null,
      validUntil: null,
    });

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: { facts: Array<{ key: string; value: string }>; factLog: unknown[] };
    };
    expect(exported.representative.facts).toMatchObject([
      { key: "price.haircut", value: "50 USD" },
    ]);
    expect(exported.representative.factLog).toHaveLength(2);

    await deleteUserData(deps, user.id);
    const after = (await exportUserData(deps, user.id)) as unknown as typeof exported;
    expect(after.representative.facts).toEqual([]);
    expect(after.representative.factLog).toEqual([]);
  });
});
