import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import { message } from "../../../../core/server/db/schema/chat";
import type { AppDeps, HostProvider } from "../../../../core/server/deps";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { insertUser, type TestUser } from "../../../support/users";
import { sendAs } from "../../../support/sdk";
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

function chatRequest(command: Record<string, unknown>) {
  // useChat posts an AG-UI RunAgentInput; our command rides in `forwardedProps`.
  return new Request("http://localhost/api/chat/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [], forwardedProps: command }),
  });
}

/** A scripted run as `user` on `model`, with the adapter calls recorded. */
async function setup({
  user,
  model = anthropicModel,
  deps: overrides = {},
}: {
  user?: TestUser;
  model?: string;
  deps?: TestDepsOverrides;
}) {
  const owner = user ?? (await insertUser());
  const fake = createFakeAdapter({ rounds: [round(text("Hello"))] });
  const adapterCalls: Array<{
    model: string;
    credentials: Record<string, string>;
    options?: { maxOutputTokens?: number };
  }> = [];
  const deps: AppDeps = createTestDeps({
    adapterFor: (adapterModel, credentials, options) => {
      adapterCalls.push({ model: adapterModel, credentials, options });
      return fake.adapter;
    },
    ...overrides,
  });
  // Titled, so no automatic title call takes the scripted adapter.
  const conv = await insertConversation(owner, { model, title: "Test Conversation" });
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
  return { owner, deps, adapterCalls, conv, send };
}

describe("Host credentials in a Run", () => {
  it("runs a user with no credentials on a Host Model, with the Host credentials and the Model's output cap", async () => {
    const { send, adapterCalls, conv } = await setup({ deps: { hostProviders } });

    const response = await send();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"delta":"Hello"');
    expect(adapterCalls).toEqual([
      { model: anthropicModel, credentials: hostCredentials, options: { maxOutputTokens: 512 } },
    ]);
    const [reply] = await getTestDb()
      .select({ status: message.status })
      .from(message)
      .where(eq(message.conversationId, conv.id))
      .orderBy(asc(message.createdAt));
    expect(reply?.status).toBe("complete");
  });

  it("uses the user's own key for the same Provider and Model, never the Host credentials", async () => {
    const user = await insertUser();
    const { send, adapterCalls, deps } = await setup({ user, deps: { hostProviders } });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });

    await (await send()).text();

    expect(adapterCalls).toEqual([
      { model: anthropicModel, credentials: { apiKey: "sk-ant-own-key" }, options: {} },
    ]);
  });

  it("ignores the user's own key when byok is off", async () => {
    const user = await insertUser();
    const { send, adapterCalls, deps } = await setup({
      user,
      deps: { hostProviders, byok: false },
    });
    await saveCredentials(deps, user.id, {
      service: "anthropic",
      fields: { apiKey: "sk-ant-own-key" },
      hint: "…-key",
      verified: true,
    });

    await (await send()).text();

    expect(adapterCalls.map((call) => call.credentials)).toEqual([hostCredentials]);
  });

  it("refuses a Model that neither the user's credentials nor the Host offer", async () => {
    const { send, adapterCalls } = await setup({
      model: "openai:gpt-5.6",
      deps: { hostProviders },
    });

    const response = await send();

    expect(response.status).toBe(400);
    expect(adapterCalls).toEqual([]);
  });

  it("never writes the Host credentials to any stored row", async () => {
    const { send, conv } = await setup({ deps: { hostProviders } });
    await (await send()).text();

    const db = getTestDb();
    // The Run wrote its reply, so the scan below covers real rows.
    const replies = await db
      .select({ status: message.status })
      .from(message)
      .where(eq(message.conversationId, conv.id));
    expect(replies.map((row) => row.status)).toContain("complete");

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
