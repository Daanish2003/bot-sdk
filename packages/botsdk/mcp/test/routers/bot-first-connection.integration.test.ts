import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botRoutine } from "@botsdk/bot/storage";
import { mcp } from "../../src";
import type { McpServerConfig } from "../../src";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { inProcessRunner, type JobRunner, systemClock } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { createFakeMcpAuth, fakeMcpResource } from "@ai-chat/test-support/fake-mcp-auth";
import { createFakeMcpServer } from "@ai-chat/test-support/fake-mcp-server";
import { followSend } from "@ai-chat/test-support/follow-send";
import { chatRpc, createTestChat } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser, type TestUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const basePath = "http://localhost/api/chat";
const clientId = "ai-chat-test";
const clientSecret = "test-client-secret";

const linear: McpServerConfig = {
  key: "linear",
  name: "Linear",
  url: fakeMcpResource,
  oauth: { clientId, clientSecret },
};

const mcpOrigin = new URL(fakeMcpResource).origin;

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/**
 * Two Bots of a user who has no Connection yet, on the fake Linear server. With `turnBeforeMcp`, the
 * first Bot has a Turn on a Host without the `mcp` feature first, so its Prompt start lacks the
 * section, and then the Host turns the feature on.
 */
async function botsWithoutConnection(
  queue: ReturnType<typeof round>[] = [],
  { turnBeforeMcp = false }: { turnBeforeMcp?: boolean } = {},
) {
  const fake = createFakeAdapter({
    rounds: Array.from(
      { length: 40 },
      () => (options: TextOptions) => (isTurnCall(options) ? (queue.shift() ?? round()) : round()),
    ),
  });
  const auth = createFakeMcpAuth({ clientId, clientSecret });
  const server = createFakeMcpServer({ auth, tools: [{ name: "list_issues" }] });
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const isEndpoint = url.origin === mcpOrigin && url.pathname === "/mcp";
    return (isEndpoint ? server.fetch : auth.fetch)(input, init);
  }) as typeof globalThis.fetch;
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: systemClock,
    jobs: () => deps!.parts.jobs,
  });
  const host = (features: NonNullable<Parameters<typeof createTestSdk>[0]>["features"]) =>
    createTestSdk({
      computer: fakeComputerProvider().provider,
      features,
      fetch,
      jobs,
      adapterFor: () => fake.adapter,
      memory: false,
    });
  deps = host(turnBeforeMcp ? [] : [mcp({ servers: [linear] })]);
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  let client = chatRpc({ user, deps });
  const { id: first } = await client.bots.create({ name: "Ada", model });
  const { id: second } = await client.bots.create({ name: "Bea", model });
  if (turnBeforeMcp) {
    await send(client, first, "before mcp");
    deps = host([mcp({ servers: [linear] })]);
    client = chatRpc({ user, deps });
  }
  return { fake, auth, deps, user, client, first, second };
}

/** Signs `user` in to the Linear server through the plugin's OAuth routes. */
async function connect(user: TestUser, deps: TestDeps, auth: ReturnType<typeof createFakeMcpAuth>) {
  const chat = createTestChat({ user, deps });
  const start = await chat.fetch(
    new Request(`${basePath}/mcp/connect?server=linear&returnTo=/settings/keys`, {
      redirect: "manual",
    }),
  );
  await chat.fetch(
    new Request(auth.approve(start.headers.get("location") ?? ""), { redirect: "manual" }),
  );
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  for await (const _event of await followSend(client, {
    botId,
    id: uuidv7(),
    text,
    timeZone: "Europe/London",
  })) {
    // Read to the end of the Turn.
  }
}

const messagesOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

/** The newest message of the first Turn call whose newest message holds `text`. */
function newestWith(calls: TextOptions[], text: string): string {
  for (const call of calls.filter(isTurnCall)) {
    const newest = String(messagesOf(call).at(-1)?.content);
    if (newest.includes(text)) return newest;
  }
  throw new Error(`No call's newest message holds "${text}"`);
}

const systemText = (call: TextOptions | undefined) =>
  (call?.systemPrompts ?? [])
    .map((prompt) => (typeof prompt === "string" ? prompt : prompt.content))
    .join("\n");

describe("The first Connection", () => {
  it("is noted once in the next Turn of each of the user's Bots, saying which is the first", async () => {
    const { fake, auth, deps, user, client, first, second } = await botsWithoutConnection();

    await send(client, first, "before one");
    await send(client, second, "before two");
    expect(newestWith(fake.calls, "before one")).not.toContain("first Connection");

    await connect(user, deps, auth);
    await send(client, first, "after one");
    await send(client, second, "after two");
    await send(client, first, "later one");

    const forFirst = newestWith(fake.calls, "after one");
    expect(forFirst).toContain("The user connected their first Connection");
    expect(forFirst).toContain(
      "You are their first Bot: offer them the Morning brief and the Watch",
    );
    const forSecond = newestWith(fake.calls, "after two");
    expect(forSecond).toContain("The user connected their first Connection");
    expect(forSecond).toContain("You are not their first Bot");
    // Told once.
    expect(newestWith(fake.calls, "later one")).not.toContain("first Connection");
  });

  it("is noted in the first Turn of a Bot that never had a Prompt start, once", async () => {
    const { fake, auth, deps, user, client, first, second } = await botsWithoutConnection();
    await connect(user, deps, auth);

    await send(client, first, "hello one");
    await send(client, second, "hello two");
    await send(client, first, "again one");

    const forFirst = newestWith(fake.calls, "hello one");
    expect(forFirst).toContain("You are their first Bot: offer them the Morning brief");
    expect(newestWith(fake.calls, "hello two")).toContain("You are not their first Bot");
    expect(newestWith(fake.calls, "again one")).not.toContain("first Connection");
  });

  it("isn't noted for a Bot that had Turns before the Host turned the feature on", async () => {
    const { fake, auth, deps, user, client, first } = await botsWithoutConnection([], {
      turnBeforeMcp: true,
    });
    await connect(user, deps, auth);

    await send(client, first, "after mcp");

    expect(newestWith(fake.calls, "after mcp")).not.toContain("first Connection");
  });

  it("is offered to the first Bot with the default schedules and prompts in its system prompt", async () => {
    const { fake, client, first } = await botsWithoutConnection();

    await send(client, first, "hi");

    const system = systemText(fake.calls.filter(isTurnCall)[0]);
    expect(system).toContain('The Morning brief ("morning-brief"): weekdays at 08:00.');
    expect(system).toContain(
      'The Watch ("check-my-apps"): read-only (readOnly: true), weekdays at 11:00, 14:00, 17:00 and 20:00.',
    );
    expect(system).toContain("Never offer them again");
  });

  it("lets the first Bot offer both Routines with its Routine tools, pending the user's OK", async () => {
    const brief = {
      name: "morning-brief",
      prompt: "Review.",
      schedule: { days: ["mon"], times: ["08:00"] },
    };
    const watch = {
      name: "check-my-apps",
      prompt: "Check.",
      schedule: { days: ["mon"], times: ["11:00", "14:00"] },
      readOnly: true,
    };
    const { auth, deps, user, client, first } = await botsWithoutConnection([
      round(),
      round(
        toolCall({ name: "create_routine", input: brief }),
        toolCall({ name: "create_routine", input: watch }),
      ),
      round(),
    ]);
    await send(client, first, "before");
    await connect(user, deps, auth);

    await send(client, first, "after");

    const routines = await getTestDb()
      .select({ name: botRoutine.name, state: botRoutine.state, readOnly: botRoutine.readOnly })
      .from(botRoutine)
      .where(eq(botRoutine.botId, first));
    expect(routines.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "check-my-apps", state: "pending", readOnly: true },
      { name: "morning-brief", state: "pending", readOnly: false },
    ]);
  });
});
