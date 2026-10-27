import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { saveCredentials } from "@botsdk/bot/models/internal";
import { botTurn, usage } from "@botsdk/bot/storage";
import type { HostProvider, LinkedCredentials } from "@botsdk/bot/models/internal";
import { botOf, botSdk, sendToTurnEnd, stopBotRunners } from "../../../support/bot-turns";
import { createTestSdk, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, runError, toolCall } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { insertUser, type TestUser } from "../../../support/users";
import { getTestDb } from "../../../support/test-database";

// A Model on the ChatGPT plan's list (ADR 0023), and an OpenAI Model that isn't.
const planModel = "openai:gpt-6.1-sol";
const linked = { apiKey: "chatgpt-access-token" };
const hostCredentials = { apiKey: "sk-host-openai" };
const hostOffers = (...modelIds: string[]): HostProvider[] => [
  {
    provider: "openai",
    credentials: hostCredentials,
    models: modelIds.map((modelId) => ({
      modelId,
      maxOutputTokens: 512,
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    })),
  },
];

afterEach(stopBotRunners);

/**
 * A Bot SDK with a fake `linkedCredentials` hook and the model calls recorded, whose Turns play
 * `rounds`.
 */
async function setup({
  user,
  link = linked,
  rounds = [round(toolCall({ name: "send_to_user", input: { text: "Hello", endTurn: true } }))],
  deps: overrides = {},
}: {
  user?: TestUser;
  link?: LinkedCredentials;
  rounds?: Parameters<typeof createFakeAdapter>[0]["rounds"];
  deps?: TestDepsOverrides;
}) {
  const owner = user ?? (await insertUser());
  const fake = createFakeAdapter({ rounds });
  const adapterCalls: Array<{
    model: string;
    credentials: Record<string, string>;
    options?: { maxOutputTokens?: number; linked?: boolean };
  }> = [];
  const hookCalls: Array<{ userId: string; service: string }> = [];
  const { deps } = await botSdk({
    adapterFor: (adapterModel, credentials, options) => {
      adapterCalls.push({ model: adapterModel, credentials, options });
      return fake.adapter;
    },
    linkedCredentials: async (userId, service) => {
      hookCalls.push({ userId, service });
      return link;
    },
    ...overrides,
  });
  return { owner, deps, adapterCalls, hookCalls };
}

/** How the Bot's only Turn ended. */
async function turnOf(botId: string) {
  const [turn] = await getTestDb()
    .select({ status: botTurn.status, error: botTurn.error })
    .from(botTurn)
    .where(eq(botTurn.botId, botId));
  return turn;
}

describe("A linked ChatGPT plan in a Bot's Turn (ADR 0023)", () => {
  it("runs a plan Model on the linked credentials when the user has no OpenAI key", async () => {
    const { owner, deps, adapterCalls, hookCalls } = await setup({});
    const { client, botId } = await botOf(deps, owner, planModel);

    await sendToTurnEnd(client, botId);

    expect(hookCalls).toContainEqual({ userId: owner.id, service: "openai" });
    expect(adapterCalls).toEqual([
      { model: planModel, credentials: linked, options: { linked: true } },
    ]);
    expect(await turnOf(botId)).toMatchObject({ status: "complete" });
  });

  it("uses the user's OpenAI key when they have both a key and a linked plan", async () => {
    const user = await insertUser();
    const { deps, adapterCalls } = await setup({ user });
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "sk-own-openai" },
      hint: "…enai",
      verified: true,
    });
    const { client, botId } = await botOf(deps, user, planModel);

    await sendToTurnEnd(client, botId);

    expect(adapterCalls).toEqual([
      { model: planModel, credentials: { apiKey: "sk-own-openai" }, options: {} },
    ]);
  });

  it("ignores the link when byok is off, running on the Host's credentials", async () => {
    const { owner, deps, adapterCalls } = await setup({
      deps: { byok: false, hostProviders: hostOffers("gpt-6.1-sol") },
    });
    const { client, botId } = await botOf(deps, owner, planModel);

    await sendToTurnEnd(client, botId);

    expect(adapterCalls.map((call) => call.credentials)).toEqual([hostCredentials]);
  });

  it("never uses the link for an OpenAI Model the plan doesn't offer", async () => {
    const offered = await setup({ deps: { hostProviders: hostOffers("gpt-5.4-mini") } });
    const { client, botId } = await botOf(offered.deps, offered.owner, "openai:gpt-5.4-mini");
    await sendToTurnEnd(client, botId);
    expect(offered.adapterCalls.map((call) => call.credentials)).toEqual([hostCredentials]);

    const notOffered = await setup({});
    const refused = await botOf(notOffered.deps, notOffered.owner, "openai:gpt-5.4-mini").then(
      () => null,
      (caught: unknown) => caught as { status?: number },
    );
    expect(refused).toMatchObject({ status: 400 });
    expect(notOffered.adapterCalls).toEqual([]);
  });

  it("checks no Quota and writes only cost-free usage on the linked plan, even when the Host offers the Model", async () => {
    const { owner, deps, adapterCalls } = await setup({
      deps: {
        hostProviders: hostOffers("gpt-6.1-sol"),
        // A spent Quota: a call on Host credentials would be refused.
        getQuota: async () => ({ budgetUsd: 0, window: "day" }),
      },
    });
    const { client, botId } = await botOf(deps, owner, planModel);

    await sendToTurnEnd(client, botId);

    expect(adapterCalls.map((call) => call.credentials)).toEqual([linked]);
    expect(await turnOf(botId)).toMatchObject({ status: "complete" });
    const rows = await getTestDb().select().from(usage).where(eq(usage.userId, owner.id));
    expect(rows.map((row) => row.costMicros)).toEqual([0]);
  });

  it("fails the Turn asking to reconnect when the link is broken, never using the Host's credentials", async () => {
    const { owner, deps, adapterCalls } = await setup({
      link: "needs-reconnect",
      deps: { hostProviders: hostOffers("gpt-6.1-sol") },
    });
    const { client, botId } = await botOf(deps, owner, planModel);

    const events = await sendToTurnEnd(client, botId);

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "error" });
    expect(adapterCalls).toEqual([]);
    expect(await turnOf(botId)).toEqual({
      status: "error",
      error: "Reconnect ChatGPT on the Keys page",
    });
  });

  it("fails the Turn with OpenAI's message when the plan rejects the call, never retrying on the Host's credentials", async () => {
    const { owner, deps, adapterCalls } = await setup({
      rounds: [round(runError("You've hit your usage limit.", "usage_limit_reached"))],
      deps: { hostProviders: hostOffers("gpt-6.1-sol") },
    });
    const { client, botId } = await botOf(deps, owner, planModel);

    await sendToTurnEnd(client, botId);

    expect(adapterCalls.map((call) => call.credentials)).toEqual([linked]);
    expect(await turnOf(botId)).toEqual({
      status: "error",
      error: "You've hit your usage limit.",
    });
  });
});

describe("A linked ChatGPT plan in the Model picker and the Keys page (ADR 0023)", () => {
  /** The caller's client, on an SDK whose hook answers `link`. */
  async function clientWith(link: LinkedCredentials, overrides: TestDepsOverrides = {}) {
    const user = await insertUser();
    const deps = createTestSdk({ linkedCredentials: async () => link, ...overrides });
    return { user, deps, client: chatRpc({ user, deps }) };
  }

  it("offers the plan's Models as the user's own, not the Host's, and starts a new Conversation on one", async () => {
    const { client } = await clientWith(linked, {
      hostProviders: hostOffers("gpt-6.1-sol", "gpt-5.4-mini"),
    });

    const { models, defaultModel } = await client.models.list();

    expect(models.map((model) => [model.id, model.onHostCredentials])).toEqual([
      ["openai:gpt-6.1-sol", false],
      ["openai:gpt-6-luna", false],
      ["openai:gpt-5.4-mini", true],
    ]);
    expect(defaultModel).toBe("openai:gpt-6-luna");
  });

  it("offers no plan Models with nothing linked, or with byok off", async () => {
    const unlinked = await clientWith(null);
    expect((await unlinked.client.models.list()).models).toEqual([]);

    const byokOff = await clientWith(linked, {
      byok: false,
      hostProviders: hostOffers("gpt-5.4-mini"),
    });
    expect((await byokOff.client.models.list()).models.map((model) => model.id)).toEqual([
      "openai:gpt-5.4-mini",
    ]);
  });

  it("keeps the picker and the Keys page working when the Host's hook fails, showing no link", async () => {
    const { client } = await clientWith(null, {
      hostProviders: hostOffers("gpt-5.4-mini"),
      linkedCredentials: async () => {
        throw new Error("The auth database is down");
      },
    });

    expect((await client.models.list()).models.map((model) => model.id)).toEqual([
      "openai:gpt-5.4-mini",
    ]);
    expect(await client.models.credentials.openaiState()).toBe("none");
  });

  it("reports the OpenAI row as key, linked, needs reconnect or none", async () => {
    const withKey = await clientWith(linked);
    await saveCredentials(withKey.deps, withKey.user.id, {
      service: "openai",
      fields: { apiKey: "sk-own-openai" },
      hint: "…enai",
      verified: true,
    });
    expect(await withKey.client.models.credentials.openaiState()).toBe("key");

    expect(await (await clientWith(linked)).client.models.credentials.openaiState()).toBe("linked");
    expect(
      await (await clientWith("needs-reconnect")).client.models.credentials.openaiState(),
    ).toBe("needs-reconnect");
    expect(await (await clientWith(null)).client.models.credentials.openaiState()).toBe("none");
    // With byok off, neither a link nor a key is used.
    const byokOff = await clientWith(linked, { byok: false });
    await saveCredentials(byokOff.deps, byokOff.user.id, {
      service: "openai",
      fields: { apiKey: "sk-own-openai" },
      hint: "…enai",
      verified: true,
    });
    expect(await byokOff.client.models.credentials.openaiState()).toBe("none");

    // A Host without the hook: only the stored key counts.
    const user = await insertUser();
    const noHook = chatRpc({ user, deps: createTestSdk() });
    expect(await noHook.models.credentials.openaiState()).toBe("none");
  });
});
