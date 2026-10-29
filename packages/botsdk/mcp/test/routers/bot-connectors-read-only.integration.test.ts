import type { ModelMessage } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botTurn } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { claimJob, inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { mcp } from "../../src";
import type { McpServerConfig } from "../../src";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { createFakeMcpAuth, fakeMcpResource } from "@ai-chat/test-support/fake-mcp-auth";
import { createFakeMcpServer, type FakeMcpTool } from "@ai-chat/test-support/fake-mcp-server";
import { fakeReviewer } from "@botsdk/testing/fake-reviewer";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { followSend } from "@ai-chat/test-support/follow-send";
import { chatRpc, createTestChat } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const basePath = "http://localhost/api/chat";
const clientId = "ai-chat-test";
const clientSecret = "test-client-secret";
const mcpOrigin = new URL(fakeMcpResource).origin;

/** Every tool is approval-free, so a refusal in these tests can only come from the read-only gate. */
const linear: McpServerConfig = {
  key: "linear",
  name: "Linear",
  url: fakeMcpResource,
  oauth: { clientId, clientSecret },
  approvalFree: ["list_issues", "get_team", "create_issue", "update_issue"],
  readOnlyTools: ["get_team"],
};

const tools: FakeMcpTool[] = [
  { name: "list_issues", annotations: { readOnlyHint: true } },
  { name: "get_team" },
  { name: "create_issue" },
  { name: "update_issue", annotations: { readOnlyHint: false } },
];

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const call = (name: string, input: unknown) => toolCall({ id: `call-${name}`, name, input });

// Sunday 18 October 2026, 11:00 in London; the Routine fires on Monday 19 October at 11:00.
const sunday = new Date("2026-10-18T10:00:00.000Z");

/** Runs the Monday fire of a Routine created `readOnly` or not, whose Turn runs every Connector tool. */
async function fireRoutine(readOnly: boolean) {
  const timer = fakeJobClock(sunday);
  const run = (name: string) =>
    toolCall({ id: `call-${name}`, name: "run_tool", input: { name: `linear_${name}`, args: {} } });
  const fake = createFakeAdapter({
    rounds: [
      round(
        call("create_routine", {
          name: "check-linear",
          prompt: "Look through Linear.",
          schedule: { days: ["mon"], times: ["11:00"] },
          readOnly,
        }),
      ),
      round(),
      round(...tools.map((tool) => run(tool.name))),
      round(),
    ],
  });
  const auth = createFakeMcpAuth({ clientId, clientSecret });
  const server = createFakeMcpServer({ auth, tools });
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
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: fakeComputerProvider().provider,
    features: [mcp({ servers: [linear] })],
    fetch,
    jobs,
    clock: timer.clock.now,
    adapterFor: () => fake.adapter,
    reviewAdapterFor: () => fakeReviewer().adapter,
    memory: false,
  });
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const chat = createTestChat({ user, deps });
  const start = await chat.fetch(
    new Request(`${basePath}/mcp/connect?server=linear&returnTo=/settings/keys`, {
      redirect: "manual",
    }),
  );
  await chat.fetch(
    new Request(auth.approve(start.headers.get("location") ?? ""), { redirect: "manual" }),
  );
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada", model });

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  const stream = await followSend(client, {
    botId,
    id: uuidv7(),
    text: "Check Linear on Mondays",
    timeZone: "Europe/London",
  });
  await stream.next();
  await stream.return(undefined);
  timer.advance(500);
  await runDue();
  const [listed] = await client.routines.list({ botId });
  await client.routines.approve({ routineId: listed!.id });
  timer.advance(new Date("2026-10-19T10:00:00.000Z").getTime() - timer.clock.now().getTime());
  await runDue();
  timer.advance(500);
  await runDue();

  const turns = await getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));
  const results: Record<string, string> = {};
  for (const entry of (turns[1]!.transcript ?? []) as ModelMessage[]) {
    if (entry.role === "tool" && entry.toolCallId?.startsWith("call-"))
      results[entry.toolCallId.slice("call-".length)] = String(entry.content);
  }
  return { results, server };
}

const refused = JSON.stringify({
  error: "This check is read-only. Draft it and ask the user.",
});

describe("Connector tools in a read-only run", () => {
  it("runs a tool with readOnlyHint or named in readOnlyTools, and refuses the rest", async () => {
    const { results, server } = await fireRoutine(true);

    expect(results.list_issues).not.toBe(refused);
    expect(results.get_team).not.toBe(refused);
    expect(results.create_issue).toBe(refused);
    expect(results.update_issue).toBe(refused);
    expect(server.calls.map((each) => each.name).sort()).toEqual(["get_team", "list_issues"]);
  });

  it("changes nothing outside a read-only run", async () => {
    const { results, server } = await fireRoutine(false);

    for (const name of Object.keys(results)) expect(results[name]).not.toBe(refused);
    expect(server.calls.map((each) => each.name).sort()).toEqual([
      "create_issue",
      "get_team",
      "list_issues",
      "update_issue",
    ]);
  });
});
