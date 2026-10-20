import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { message, usage } from "../../../../core/server/db/schema";
import type { HostProvider } from "../../../../plugins/assistant/server/deps";
import type { LinkedCredentials } from "../../../../plugins/models/server/types";
import { insertConversation } from "../../../support/conversations";
import { createTestSdk, type TestDepsOverrides, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, runError, text } from "../../../support/fake-adapter";
import { insertUser, type TestUser } from "../../../support/users";
import { chatRpc, sendAs } from "../../../support/sdk";
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

function chatRequest(command: Record<string, unknown>) {
  // useChat posts an AG-UI RunAgentInput; our command rides in `forwardedProps`.
  return new Request("http://localhost/api/chat/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [], forwardedProps: command }),
  });
}

/** A scripted Run as `user` on `model`, with a fake `linkedCredentials` hook and the adapter calls recorded. */
async function setup({
  user,
  model = planModel,
  link = linked,
  rounds = [round(text("Hello"))],
  deps: overrides = {},
}: {
  user?: TestUser;
  model?: string;
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
  const deps: TestDeps = createTestSdk({
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
  // Titled, so no automatic title call takes the scripted adapter.
  const conv = await insertConversation(owner, { model, title: "Linked" });
  const send = () =>
    sendAs(
      chatRequest({
        conversationId: conv.id,
        parentId: null,
        text: "Hi",
        attachmentIds: [],
        model,
        webSearch: false,
      }),
      owner,
      deps,
    );
  return { owner, deps, adapterCalls, hookCalls, conv, send };
}

async function replyOf(conversationId: string) {
  const rows = await getTestDb()
    .select({ role: message.role, status: message.status, error: message.error })
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.find((row) => row.role === "assistant");
}

describe("A linked ChatGPT plan in a Run (ADR 0023)", () => {
  it("runs a plan Model on the linked credentials when the user has no OpenAI key", async () => {
    const { send, adapterCalls, hookCalls, owner, conv } = await setup({});

    const response = await send();
    expect(await response.text()).toContain('"delta":"Hello"');

    expect(hookCalls).toContainEqual({ userId: owner.id, service: "openai" });
    expect(adapterCalls).toEqual([
      { model: planModel, credentials: linked, options: { linked: true } },
    ]);
    expect((await replyOf(conv.id))?.status).toBe("complete");
  });

  it("uses the user's OpenAI key when they have both a key and a linked plan", async () => {
    const user = await insertUser();
    const { send, adapterCalls, deps } = await setup({ user });
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "sk-own-openai" },
      hint: "…enai",
      verified: true,
    });

    await (await send()).text();

    expect(adapterCalls).toEqual([
      { model: planModel, credentials: { apiKey: "sk-own-openai" }, options: {} },
    ]);
  });

  it("ignores the link when byok is off, running on the Host's credentials", async () => {
    const { send, adapterCalls } = await setup({
      deps: { byok: false, hostProviders: hostOffers("gpt-6.1-sol") },
    });

    await (await send()).text();

    expect(adapterCalls.map((call) => call.credentials)).toEqual([hostCredentials]);
  });

  it("never uses the link for an OpenAI Model the plan doesn't offer", async () => {
    const offered = await setup({
      model: "openai:gpt-5.6",
      deps: { hostProviders: hostOffers("gpt-5.6") },
    });
    await (await offered.send()).text();
    expect(offered.adapterCalls.map((call) => call.credentials)).toEqual([hostCredentials]);

    const notOffered = await setup({ model: "openai:gpt-5.6" });
    const response = await notOffered.send();
    expect(response.status).toBe(400);
    expect(notOffered.adapterCalls).toEqual([]);
  });

  it("checks no Quota and writes no usage row on the linked plan, even when the Host offers the Model", async () => {
    const { send, adapterCalls, owner, conv } = await setup({
      deps: {
        hostProviders: hostOffers("gpt-6.1-sol"),
        // A spent Quota: a call on Host credentials would be refused.
        getQuota: async () => ({ budgetUsd: 0, window: "day" }),
      },
    });

    const response = await send();
    expect(response.status).toBe(200);
    await response.text();

    expect(adapterCalls.map((call) => call.credentials)).toEqual([linked]);
    expect((await replyOf(conv.id))?.status).toBe("complete");
    const rows = await getTestDb().select().from(usage).where(eq(usage.userId, owner.id));
    expect(rows).toEqual([]);
  });

  it("fails the Run asking to reconnect when the link is broken, never using the Host's credentials", async () => {
    const { send, adapterCalls, conv } = await setup({
      link: "needs-reconnect",
      deps: { hostProviders: hostOffers("gpt-6.1-sol") },
    });

    await (await send()).text();

    expect(adapterCalls).toEqual([]);
    const reply = await replyOf(conv.id);
    expect(reply).toMatchObject({ status: "error", error: "Reconnect ChatGPT on the Keys page" });
  });

  it("fails the Run with OpenAI's message when the plan rejects the call, never retrying on the Host's credentials", async () => {
    const { send, adapterCalls, conv } = await setup({
      rounds: [round(runError("You've hit your usage limit.", "usage_limit_reached"))],
      deps: { hostProviders: hostOffers("gpt-6.1-sol") },
    });

    await (await send()).text();

    expect(adapterCalls.map((call) => call.credentials)).toEqual([linked]);
    const reply = await replyOf(conv.id);
    expect(reply).toMatchObject({ status: "error", error: "You've hit your usage limit." });
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
      hostProviders: hostOffers("gpt-6.1-sol", "gpt-5.6"),
    });

    const { models, defaultModel } = await client.models.list();

    expect(models.map((model) => [model.id, model.onHostCredentials])).toEqual([
      ["openai:gpt-6.1-sol", false],
      ["openai:gpt-6-luna", false],
      ["openai:gpt-5.6", true],
    ]);
    expect(defaultModel).toBe("openai:gpt-6.1-sol");
  });

  it("offers no plan Models with nothing linked, or with byok off", async () => {
    const unlinked = await clientWith(null);
    expect((await unlinked.client.models.list()).models).toEqual([]);

    const byokOff = await clientWith(linked, {
      byok: false,
      hostProviders: hostOffers("gpt-5.6"),
    });
    expect((await byokOff.client.models.list()).models.map((model) => model.id)).toEqual([
      "openai:gpt-5.6",
    ]);
  });

  it("keeps the picker and the Keys page working when the Host's hook fails, showing no link", async () => {
    const { client } = await clientWith(null, {
      hostProviders: hostOffers("gpt-5.6"),
      linkedCredentials: async () => {
        throw new Error("The auth database is down");
      },
    });

    expect((await client.models.list()).models.map((model) => model.id)).toEqual([
      "openai:gpt-5.6",
    ]);
    expect(await client.credentials.openaiState()).toBe("none");
  });

  it("reports the OpenAI row as key, linked, needs reconnect or none", async () => {
    const withKey = await clientWith(linked);
    await saveCredentials(withKey.deps, withKey.user.id, {
      service: "openai",
      fields: { apiKey: "sk-own-openai" },
      hint: "…enai",
      verified: true,
    });
    expect(await withKey.client.credentials.openaiState()).toBe("key");

    expect(await (await clientWith(linked)).client.credentials.openaiState()).toBe("linked");
    expect(await (await clientWith("needs-reconnect")).client.credentials.openaiState()).toBe(
      "needs-reconnect",
    );
    expect(await (await clientWith(null)).client.credentials.openaiState()).toBe("none");
    // With byok off, neither a link nor a key is used.
    const byokOff = await clientWith(linked, { byok: false });
    await saveCredentials(byokOff.deps, byokOff.user.id, {
      service: "openai",
      fields: { apiKey: "sk-own-openai" },
      hint: "…enai",
      verified: true,
    });
    expect(await byokOff.client.credentials.openaiState()).toBe("none");

    // A Host without the hook: only the stored key counts.
    const user = await insertUser();
    const noHook = chatRpc({ user, deps: createTestSdk() });
    expect(await noHook.credentials.openaiState()).toBe("none");
  });
});
