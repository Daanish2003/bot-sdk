import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botHelper, botReview, botTurn } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { mcpClient } from "../../../../plugins/mcp/client/index";
import { mcp } from "../../../../plugins/mcp/server/plugin";
import type { McpServerConfig } from "../../../../plugins/mcp/server/servers";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { claimJob } from "../../../../plugins/runner/server/jobs/store";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { createFakeMcpAuth, fakeMcpResource } from "../../../support/fake-mcp-auth";
import { createFakeMcpServer } from "../../../support/fake-mcp-server";
import { fakeReviewer } from "../../../support/fake-reviewer";
import { fakeJobClock } from "../../../support/jobs";
import { followSend } from "../../../support/follow-send";
import { chatRpc, createTestChat } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";

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
  approvalFree: ["list_issues"],
};

const mcpOrigin = new URL(fakeMcpResource).origin;

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** Whether a model call is a Helper's: its system prompt says so. */
const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) =>
    (typeof prompt === "string" ? prompt : prompt.content).startsWith("You are a Helper"),
  );

const systemText = (call: TextOptions | undefined) =>
  (call?.systemPrompts ?? [])
    .map((prompt) => (typeof prompt === "string" ? prompt : prompt.content))
    .join("\n");

const toolNames = (call: TextOptions | undefined) => (call?.tools ?? []).map((tool) => tool.name);

/**
 * A user with an OpenAI key, a Linear Connection over the fake MCP server and a Bot "Ada" with its
 * Computer. The Turns play `turns`, the Helpers `helpers`; Auto-review calls go to a fake reviewer.
 * With `at`, the runner is idle on a clock the test moves, and `runDue()` runs what is due.
 */
async function world({
  turns,
  helpers = [],
  at,
}: {
  turns: Round[];
  helpers?: Round[];
  at?: Date;
}) {
  const turnFake = createFakeAdapter({ rounds: turns });
  const helperFake = createFakeAdapter({ rounds: helpers });
  const adapter = {
    ...turnFake.adapter,
    chatStream: (options: TextOptions) =>
      isHelperCall(options)
        ? helperFake.adapter.chatStream(options)
        : turnFake.adapter.chatStream(options),
  } as AnyTextAdapter;
  const reviewer = fakeReviewer();
  const auth = createFakeMcpAuth({ clientId, clientSecret });
  const server = createFakeMcpServer({
    auth,
    tools: [{ name: "list_issues" }, { name: "create_issue" }],
  });
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const isEndpoint = url.origin === mcpOrigin && url.pathname === "/mcp";
    return (isEndpoint ? server.fetch : auth.fetch)(input, init);
  }) as typeof globalThis.fetch;
  const timer = at ? fakeJobClock(at) : undefined;
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    ...(timer && { clock: timer.clock }),
    deps: () => deps!,
  });
  deps = createTestSdk({
    computer: fakeComputerProvider().provider,
    plugins: [bot()],
    features: [mcp({ servers: [linear] })],
    fetch,
    jobs,
    adapterFor: () => adapter,
    reviewAdapterFor: () => reviewer.adapter,
    memory: false,
    ...(timer && { clock: timer.clock.now }),
  });
  if (!timer) await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const chat = createTestChat({ user, deps, clientPlugins: [mcpClient()] });
  const start = await chat.fetch(
    new Request(`${basePath}/mcp/connect?server=linear&returnTo=/settings/keys`, {
      redirect: "manual",
    }),
  );
  await chat.fetch(
    new Request(auth.approve(start.headers.get("location") ?? ""), { redirect: "manual" }),
  );
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bot.create({ name: "Ada", model });
  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer!.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  return { turnFake, helperFake, reviewer, server, client, botId, timer, runDue };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, message: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text: message })) {
    // Read to the end of the Turn.
  }
}

const sends = (message: string) =>
  toolCall({ name: "send_to_user", input: { text: message, endTurn: true } });

const handsOff = (type: "general" | "computer_use", task: string) =>
  round(toolCall({ name: "start_helper", input: { type, task } }), sends("On it."));

const viaSearch = (name: string, args: Record<string, unknown> = {}) =>
  round(toolCall({ name: "run_tool", input: { name, args } }));

async function helperEnded(botId: string) {
  await expect
    .poll(
      async () => {
        const rows = await getTestDb().select().from(botHelper).where(eq(botHelper.botId, botId));
        return rows[0]?.status;
      },
      { timeout: 10_000 },
    )
    .toMatch(/complete|error|stopped/);
}

describe("Connector tools for a Helper", () => {
  it("lets a General Helper find and call a Connector tool, Auto-reviewed against its task", async () => {
    const task = "File a bug titled Crash on save in Linear.";
    const { helperFake, reviewer, server, client, botId } = await world({
      turns: [handsOff("general", task), round()],
      helpers: [
        round(toolCall({ name: "describe_tool", input: { name: "linear_create_issue" } })),
        viaSearch("linear_create_issue", { title: "Crash on save" }),
        round(text("Filed it.")),
      ],
    });

    await send(client, botId, "file a bug");
    await helperEnded(botId);

    // Found by name in its prompt, reached through the small tool search.
    expect(systemText(helperFake.calls[0])).toContain(
      "linear_create_issue: The fake create_issue tool.",
    );
    expect(toolNames(helperFake.calls[0])).toEqual(
      expect.arrayContaining(["describe_tool", "run_tool"]),
    );
    expect(toolNames(helperFake.calls[0])).not.toContain("linear_create_issue");
    expect(server.calls).toEqual([{ name: "create_issue", arguments: { title: "Crash on save" } }]);
    // Reviewed against the task the Bot gave it.
    expect(reviewer.calls).toHaveLength(1);
    expect(JSON.stringify(reviewer.calls[0]?.messages)).toContain(task);
    const reviews = await getTestDb().select().from(botReview).where(eq(botReview.botId, botId));
    expect(reviews.map((row) => row.tool)).toEqual(["linear_create_issue"]);
  });

  it("gives a Computer-use Helper no Connector tools", async () => {
    const { helperFake, server, client, botId } = await world({
      turns: [handsOff("computer_use", "Order the blue mug."), round()],
      helpers: [round(text("Done."))],
    });

    await send(client, botId, "buy a mug");
    await helperEnded(botId);

    expect(toolNames(helperFake.calls[0])).not.toContain("run_tool");
    expect(toolNames(helperFake.calls[0])).not.toContain("describe_tool");
    expect(systemText(helperFake.calls[0])).not.toContain("linear_");
    expect(server.calls).toEqual([]);
  });
});

describe("Connector tools in a Routine Turn", () => {
  it("calls a Connector tool like any other Turn", async () => {
    const { client, botId, server, timer, runDue } = await world({
      at: new Date("2026-10-18T10:00:00.000Z"),
      turns: [
        round(
          toolCall({
            name: "create_routine",
            input: {
              name: "issue-brief",
              prompt: "List the open issues in Linear.",
              schedule: { days: ["mon"], at: "08:00" },
            },
          }),
        ),
        round(),
        viaSearch("linear_list_issues", { team: "core" }),
        round(),
      ],
    });
    const stream = await followSend(client, {
      botId,
      id: uuidv7(),
      text: "Set it up",
      timeZone: "Europe/London",
    });
    await stream.next();
    await stream.return(undefined);
    timer!.advance(500);
    await runDue();
    const [listed] = await client.bot.routine.list({ botId });
    await client.bot.routine.approve({ routineId: listed!.id });

    timer!.advance(new Date("2026-10-19T07:00:00.000Z").getTime() - timer!.clock.now().getTime());
    await runDue();
    timer!.advance(500);
    await runDue();

    expect(server.calls).toEqual([{ name: "list_issues", arguments: { team: "core" } }]);
    const turns = await getTestDb()
      .select()
      .from(botTurn)
      .where(eq(botTurn.botId, botId))
      .orderBy(asc(botTurn.startedAt));
    expect(turns.at(-1)?.status).toBe("complete");
  });
});
