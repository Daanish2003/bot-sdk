import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { representative } from "../src";
import { representativeProfileValue } from "../src/server/db/schema";

/*
 * A Customer's typed profile as the owner defines and corrects it (ticket #1280), through the owner
 * API on real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const today = new Date("2026-11-04T09:30:00Z");
const notFound = { code: "NOT_FOUND" };
const badInput = { code: "BAD_REQUEST" };
const taken = { code: "CONFLICT", data: { code: "error.profileFieldTaken" } };

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

async function instance(clock = () => today) {
  const fake = createFakeAdapter({
    rounds: [round()],
  });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [representative()],
    adapterFor: () => fake.adapter,
    clock,
    memory: false,
  });
  await jobs.start();
  runners.push(jobs);
  return deps;
}

async function owner(deps: TestDeps) {
  const user = await insertUser();
  return { user, rpc: chatRpc({ user, deps }) };
}

type Rpc = Awaited<ReturnType<typeof owner>>["rpc"];

const addCustomer = (rpc: Rpc, input: { name?: string; externalId?: string } = {}) =>
  rpc.representative.customerCreate({
    channel: "sms",
    externalId: input.externalId ?? "+15550001",
    ...(input.name !== undefined && { name: input.name }),
  });

const ownerValue = (field: string, value: string) => ({
  field,
  value,
  source: "owner",
  status: "confirmed",
  recordedAt: today,
});

describe("the owner's own profile fields", () => {
  it("adds, renames and removes a field, and removing it removes its values", async () => {
    const deps = await instance();
    const { rpc } = await owner(deps);
    const ada = await addCustomer(rpc);

    const field = await rpc.representative.profileFieldAdd({ name: " Equipment " });
    expect(field.name).toBe("Equipment");
    expect(await rpc.representative.profileFieldList()).toEqual([field]);

    const renamed = await rpc.representative.profileFieldRename({
      id: field.id,
      name: "Boiler model",
    });
    expect(renamed).toEqual({ id: field.id, name: "Boiler model" });

    const set = await rpc.representative.customerProfileSet({
      id: ada.id,
      field: field.id,
      value: "Vaillant 32",
    });
    expect(set.profile).toEqual([ownerValue(field.id, "Vaillant 32")]);

    await rpc.representative.profileFieldRemove({ id: field.id });
    expect(await rpc.representative.profileFieldList()).toEqual([]);
    const [after] = await rpc.representative.customerList();
    expect(after?.profile).toEqual([]);
  });

  it("refuses a name already taken, whatever its case, or a fixed field's, and lets a field recase its own", async () => {
    const deps = await instance();
    const { rpc } = await owner(deps);
    const field = await rpc.representative.profileFieldAdd({ name: "Equipment" });
    const other = await rpc.representative.profileFieldAdd({ name: "Gate code" });

    await expect(rpc.representative.profileFieldAdd({ name: "equipment" })).rejects.toMatchObject(
      taken,
    );
    await expect(
      rpc.representative.profileFieldRename({ id: other.id, name: "EQUIPMENT" }),
    ).rejects.toMatchObject(taken);
    for (const name of ["name", "Language", "Preferred Channel", "ADDRESS"]) {
      await expect(rpc.representative.profileFieldAdd({ name })).rejects.toMatchObject(taken);
    }
    await expect(
      rpc.representative.profileFieldRename({ id: other.id, name: "address" }),
    ).rejects.toMatchObject(taken);
    await expect(
      rpc.representative.profileFieldRename({ id: field.id, name: "equipment" }),
    ).resolves.toEqual({ id: field.id, name: "equipment" });

    // Another owner's field of the same name is no clash.
    const { rpc: theirs } = await owner(deps);
    await expect(
      theirs.representative.profileFieldAdd({ name: "equipment" }),
    ).resolves.toBeDefined();
  });
});

describe("a Customer's profile values", () => {
  it("sets the fixed fields and an own field as confirmed, by the owner, today", async () => {
    const deps = await instance();
    const { rpc } = await owner(deps);
    const ada = await addCustomer(rpc);
    const field = await rpc.representative.profileFieldAdd({ name: "Equipment" });

    await rpc.representative.customerProfileSet({ id: ada.id, field: "language", value: " nl " });
    await rpc.representative.customerProfileSet({
      id: ada.id,
      field: "preferred_channel",
      value: "sms",
    });
    await rpc.representative.customerProfileSet({ id: ada.id, field: "address", value: "1 Road" });
    const set = await rpc.representative.customerProfileSet({
      id: ada.id,
      field: field.id,
      value: "Vaillant 32",
    });

    const expected = [
      ownerValue("language", "nl"),
      ownerValue("preferred_channel", "sms"),
      ownerValue("address", "1 Road"),
      ownerValue(field.id, "Vaillant 32"),
    ];
    expect(set.profile).toHaveLength(4);
    expect(set.profile).toEqual(expect.arrayContaining(expected));
    const [listed] = await rpc.representative.customerList();
    expect(listed?.profile).toHaveLength(4);
    expect(listed?.profile).toEqual(expect.arrayContaining(expected));
  });

  it("corrects a claimed value into a confirmed owner value, leaving one row", async () => {
    const deps = await instance();
    const { user, rpc } = await owner(deps);
    const ada = await addCustomer(rpc);
    await getTestDb()
      .insert(representativeProfileValue)
      .values({
        id: "01966b00-0000-7000-8000-000000000001",
        userId: user.id,
        customerId: ada.id,
        fixedField: "address",
        value: "1 Old Road",
        source: "customer",
        status: "claimed",
        recordedAt: new Date("2026-01-01T00:00:00Z"),
      });

    const corrected = await rpc.representative.customerProfileSet({
      id: ada.id,
      field: "address",
      value: "2 New Road",
    });

    expect(corrected.profile).toEqual([ownerValue("address", "2 New Road")]);
  });

  it("clears a value with an empty one", async () => {
    const deps = await instance();
    const { rpc } = await owner(deps);
    const ada = await addCustomer(rpc);
    await rpc.representative.customerProfileSet({ id: ada.id, field: "address", value: "1 Road" });

    const cleared = await rpc.representative.customerProfileSet({
      id: ada.id,
      field: "address",
      value: "  ",
    });
    expect(cleared.profile).toEqual([]);
  });

  it("refuses a field that doesn't exist", async () => {
    const deps = await instance();
    const { rpc } = await owner(deps);
    const ada = await addCustomer(rpc);
    await expect(
      rpc.representative.customerProfileSet({ id: ada.id, field: "shoe_size", value: "9" }),
    ).rejects.toMatchObject(badInput);
    await expect(
      rpc.representative.customerProfileSet({
        id: ada.id,
        field: "01966b00-0000-7000-8000-000000000002",
        value: "9",
      }),
    ).rejects.toMatchObject(notFound);
    // The name has its own path, with its own limit.
    await expect(
      rpc.representative.customerProfileSet({ id: ada.id, field: "name", value: "Ada" }),
    ).rejects.toMatchObject(badInput);
  });
});

describe("a Customer's name", () => {
  it("is a confirmed owner value of the profile, from the create form and from a rename", async () => {
    const deps = await instance();
    const { user, rpc } = await owner(deps);
    const ada = await addCustomer(rpc, { name: "Ada" });
    expect(ada.name).toBe("Ada");
    expect(ada.profile).toEqual([ownerValue("name", "Ada")]);

    const renamed = await rpc.representative.customerRename({ id: ada.id, name: "Ada L." });
    expect(renamed.name).toBe("Ada L.");
    expect(renamed.profile).toEqual([ownerValue("name", "Ada L.")]);

    const stored = await getTestDb()
      .select({ value: representativeProfileValue.value })
      .from(representativeProfileValue)
      .where(
        and(
          eq(representativeProfileValue.userId, user.id),
          eq(representativeProfileValue.fixedField, "name"),
        ),
      );
    expect(stored).toEqual([{ value: "Ada L." }]);

    const cleared = await rpc.representative.customerRename({ id: ada.id, name: "" });
    expect(cleared.name).toBeNull();
    expect(cleared.profile).toEqual([]);
  });

  it("still shows on a merge and on the Representative's threads", async () => {
    // A Turn runs on a clock that moves.
    const deps = await instance(() => new Date());
    const { user, rpc } = await owner(deps);
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const { id } = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({
      id,
      draft: { jobText: "Answer questions.", model: "openai:gpt-6-luna" },
    });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    await testCustomerTurn(deps, { representativeId: id, message: "Hi", externalId: "+15550001" });
    const [line] = await rpc.representative.threadList({ id });
    expect(line?.customer.name).toBeNull();

    await rpc.representative.customerRename({ id: line!.customer.id, name: "Ada" });
    const [named] = await rpc.representative.threadList({ id });
    expect(named?.customer.name).toBe("Ada");
    const thread = await rpc.representative.threadGet({ id: line!.id });
    expect(thread.customer.name).toBe("Ada");

    const bob = await addCustomer(rpc, { name: "Bob", externalId: "+15550002" });
    await rpc.representative.customerMerge({ id: bob.id, intoId: line!.customer.id });
    const [merge] = await rpc.representative.customerMergeList();
    expect(merge?.survivor.name).toBe("Ada");
    expect(merge?.absorbed.name).toBe("Bob");
  });
});

describe("another owner", () => {
  it("can neither read nor change these values or fields", async () => {
    const deps = await instance();
    const { rpc } = await owner(deps);
    const ada = await addCustomer(rpc, { name: "Ada" });
    const field = await rpc.representative.profileFieldAdd({ name: "Equipment" });
    await rpc.representative.customerProfileSet({ id: ada.id, field: field.id, value: "Vaillant" });

    const { rpc: theirs } = await owner(deps);
    const own = await addCustomer(theirs);
    expect(await theirs.representative.profileFieldList()).toEqual([]);
    expect(await theirs.representative.customerList()).toEqual([
      expect.objectContaining({ id: own.id, profile: [] }),
    ]);
    const refused = [
      () => theirs.representative.customerProfileSet({ id: ada.id, field: "address", value: "x" }),
      () => theirs.representative.customerProfileSet({ id: ada.id, field: field.id, value: "x" }),
      // Their own Customer, with this owner's field.
      () => theirs.representative.customerProfileSet({ id: own.id, field: field.id, value: "x" }),
      () => theirs.representative.customerRename({ id: ada.id, name: "Mine" }),
      () => theirs.representative.profileFieldRename({ id: field.id, name: "Mine" }),
      () => theirs.representative.profileFieldRemove({ id: field.id }),
    ];
    for (const attempt of refused) await expect(attempt()).rejects.toMatchObject(notFound);

    const [kept] = await rpc.representative.customerList();
    expect(kept?.name).toBe("Ada");
    expect(kept?.profile).toHaveLength(2);
    expect(kept?.profile).toEqual(
      expect.arrayContaining([ownerValue("name", "Ada"), ownerValue(field.id, "Vaillant")]),
    );
    expect(await rpc.representative.profileFieldList()).toEqual([field]);
  });
});

describe("the owner's export", () => {
  it("holds the fields and each Customer's values", async () => {
    const deps = await instance();
    const { user, rpc } = await owner(deps);
    const ada = await addCustomer(rpc, { name: "Ada" });
    const field = await rpc.representative.profileFieldAdd({ name: "Equipment" });
    await rpc.representative.customerProfileSet({ id: ada.id, field: field.id, value: "Vaillant" });

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: {
        profileFields: Array<{ id: string; name: string }>;
        customers: Array<{ name: string | null; profile: unknown[] }>;
      };
    };
    expect(exported.representative.profileFields).toEqual([
      expect.objectContaining({ id: field.id, name: "Equipment" }),
    ]);
    const [row] = exported.representative.customers;
    expect(row?.name).toBe("Ada");
    expect(row?.profile).toHaveLength(2);
    expect(row?.profile).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "name", value: "Ada", source: "owner" }),
        expect.objectContaining({ field: field.id, value: "Vaillant", status: "confirmed" }),
      ]),
    );
  });
});
