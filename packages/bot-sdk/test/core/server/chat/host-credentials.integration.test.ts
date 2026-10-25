import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botTurn } from "../../../../core/server/storage";
import { deleteCredentials, saveCredentials } from "../../../../plugins/models/server/internal";
import type { HostProvider } from "../../../../plugins/models/server/internal";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { botOf, botSdk, sendToTurnEnd, stopBotRunners } from "../../../support/bot-turns";
import type { TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { followSend } from "../../../support/follow-send";
import { chatRpc } from "../../../support/sdk";
import { insertUser, type TestUser } from "../../../support/users";
import { getTestDb } from "../../../support/test-database";

const anthropicModel = "anthropic:claude-sonnet-5-5";
const hostSecret = "sk-host-secret-never-stored";
const hostCredentials = { apiKey: hostSecret };
const hostProviders: HostProvider[] = [
  {
    provider: "anthropic",
    credentials: hostCredentials,
    models: [
      {
        modelId: "claude-sonnet-5-5",
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
];
const ownKey = {
  service: "anthropic",
  fields: { apiKey: "sk-ant-own-key" },
  hint: "…-key",
  verified: true,
};

afterEach(stopBotRunners);

/** A Bot SDK whose model calls are recorded, and whose Turns send "Hello" and end. */
async function setup({
  user,
  deps: overrides = {},
}: {
  user?: TestUser;
  deps?: TestDepsOverrides;
}) {
  const owner = user ?? (await insertUser());
  const fake = createFakeAdapter({
    rounds: [round(toolCall({ name: "send_to_user", input: { text: "Hello", endTurn: true } }))],
  });
  const adapterCalls: Array<{
    model: string;
    credentials: Record<string, string>;
    options?: { maxOutputTokens?: number };
  }> = [];
  const { deps } = await botSdk({
    adapterFor: (model, credentials, options) => {
      adapterCalls.push({ model, credentials, options });
      return fake.adapter;
    },
    ...overrides,
  });
  return { owner, deps, adapterCalls };
}

/** How a call that should be refused was refused. */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (caught: unknown) => caught as { status?: number; data?: { code?: string } },
  );

describe("Host credentials in a Bot's Turn", () => {
  it("runs a user with no credentials on a Host Model, with the Host credentials and the Model's output cap", async () => {
    const { owner, deps, adapterCalls } = await setup({ deps: { hostProviders } });
    const { client, botId } = await botOf(deps, owner, anthropicModel);

    const events = await sendToTurnEnd(client, botId);

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    expect(adapterCalls).toEqual([
      { model: anthropicModel, credentials: hostCredentials, options: { maxOutputTokens: 512 } },
    ]);
  });

  it("uses the user's own key for the same Provider and Model, never the Host credentials", async () => {
    const user = await insertUser();
    const { deps, adapterCalls } = await setup({ user, deps: { hostProviders } });
    await saveCredentials(deps, user.id, ownKey);
    const { client, botId } = await botOf(deps, user, anthropicModel);

    await sendToTurnEnd(client, botId);

    expect(adapterCalls).toEqual([
      { model: anthropicModel, credentials: { apiKey: "sk-ant-own-key" }, options: {} },
    ]);
  });

  it("ignores the user's own key when byok is off", async () => {
    const user = await insertUser();
    const { deps, adapterCalls } = await setup({ user, deps: { hostProviders, byok: false } });
    await saveCredentials(deps, user.id, ownKey);
    const { client, botId } = await botOf(deps, user, anthropicModel);

    await sendToTurnEnd(client, botId);

    expect(adapterCalls.map((call) => call.credentials)).toEqual([hostCredentials]);
  });

  it("refuses a Model that neither the user's credentials nor the Host offer", async () => {
    const user = await insertUser();
    const { deps, adapterCalls } = await setup({ user, deps: { hostProviders } });
    const client = chatRpc({ user, deps });

    // A new Bot on it is refused.
    expect(
      await refusal(client.bot.create({ name: "Ada", model: "openai:gpt-6-luna" })),
    ).toMatchObject({ status: 400, data: { code: "error.modelNotAvailable" } });

    // So is a send to a Bot whose Model the user's credentials no longer offer.
    await saveCredentials(deps, user.id, { ...ownKey, service: "openai" });
    const { botId } = await botOf(deps, user, "openai:gpt-6-luna");
    await deleteCredentials(deps, user.id, "openai");
    expect(await refusal(followSend(client, { botId, id: uuidv7(), text: "Hi" }))).toMatchObject({
      status: 400,
      data: { code: "error.modelNotAvailable" },
    });
    expect(adapterCalls).toEqual([]);
  });

  it("never writes the Host credentials to any stored row", async () => {
    const { owner, deps } = await setup({ deps: { hostProviders } });
    const { client, botId } = await botOf(deps, owner, anthropicModel);
    await sendToTurnEnd(client, botId);

    const db = getTestDb();
    // The Turn finished, so the scan below covers real rows.
    const turns = await db.select().from(botTurn).where(eq(botTurn.botId, botId));
    expect(turns.map((turn) => turn.status)).toEqual(["complete"]);

    const tables = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'chat'`,
    );
    const dumps = await Promise.all(
      tables.rows.map(({ table_name }) =>
        db
          .execute(sql.raw(`select * from chat."${table_name}"`))
          .then((r) => JSON.stringify(r.rows)),
      ),
    );

    expect(tables.rows.length).toBeGreaterThan(0);
    // Positive control: the dump does contain stored text, so the check below can fail.
    expect(dumps.some((dump) => dump.includes(anthropicModel))).toBe(true);
    expect(dumps.some((dump) => dump.includes(hostSecret))).toBe(false);
  });
});
