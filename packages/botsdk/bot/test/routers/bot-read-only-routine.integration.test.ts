import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botReview, botTurn } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import type { HostProvider } from "../../src/models/internal";
import { readOnlyError } from "../../src/bot/tools";
import { inProcessRunner, type JobRunner, claimJob } from "../../src/runner/internal";
import { skills } from "@botsdk/skills";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeReviewer } from "@botsdk/testing/fake-reviewer";
import { fakeJobClock } from "@ai-chat/test-support/jobs";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { followSend } from "@ai-chat/test-support/follow-send";

// Every test file here shares a worker with others: a generous test timeout and polling window.
const testTimeout = { timeout: 30_000 };
const silent = { error: () => {} };
const hostModel = "anthropic:claude-sonnet-5-5";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const hostProviders: HostProvider[] = [
  {
    provider: "anthropic",
    credentials: { apiKey: "sk-host-secret-never-stored" },
    models: [
      {
        modelId: "claude-sonnet-5-5",
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
  {
    provider: "openai",
    credentials: { apiKey: "sk-host-openai" },
    models: [],
    imageModels: [
      { modelId: "gpt-image-1-mini", size: "1024x1024", quality: "medium", pricePerImageUsd: 0.04 },
    ],
  },
];

/** A Tavily that answers every search with one result. */
const tavilyFetch: typeof globalThis.fetch = async () =>
  Response.json({ results: [{ title: "News", url: "https://news.example/a", content: "x" }] });

/** A call of tool `name`, whose id names the tool, so its result is found by name. */
const call = (name: string, input: unknown) => toolCall({ id: `call-${name}`, name, input });

const watch = {
  name: "check-my-apps",
  prompt: "Look through my apps.",
  schedule: { days: ["mon", "tue", "wed", "thu", "fri"], times: ["11:00"] },
};

// Sunday 18 October 2026, 11:00 in London (summer time, UTC+1).
const sunday = new Date("2026-10-18T10:00:00.000Z");
// Monday 19 October, 11:00 in London.
const mondaySlot = "2026-10-19T10:00:00.000Z";

/**
 * A Bot with every tool (a Computer, Skills, a Host Image Model and web search) whose Routine
 * `check-my-apps` the user approved, created by the Bot with `readOnly`, on a clock the test moves.
 * `fire()` runs its Monday fire and the Turn it wakes, which plays `rounds`.
 */
async function approvedRoutine({ readOnly, rounds }: { readOnly: boolean; rounds: Round[] }) {
  const timer = fakeJobClock(sunday);
  const fake = createFakeAdapter({
    rounds: [round(call("create_routine", { ...watch, readOnly })), round(), ...rounds],
  });
  const reviewer = fakeReviewer();
  const computerFake = fakeComputerProvider();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    features: [skills()],
    memory: false,
    jobs,
    clock: timer.clock.now,
    adapterFor: () => fake.adapter,
    reviewAdapterFor: () => reviewer.adapter,
    hostProviders,
    hostTools: [{ tool: "tavily", credentials: { apiKey: "tvly-host" }, pricePerSearchUsd: 0.01 }],
    fetch: tavilyFetch,
  });
  started.push(jobs);
  const user = await insertUser();
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada", model: hostModel });

  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  const advanceTo = (when: string) => {
    timer.advance(new Date(when).getTime() - timer.clock.now().getTime());
  };

  /** Sends the user's `text` and runs the Turn it starts. */
  const send = async (text: string) => {
    const stream = await followSend(client, {
      botId,
      id: uuidv7(),
      text,
      timeZone: "Europe/London",
    });
    await stream.next();
    await stream.return(undefined);
    timer.advance(500);
    await runDue();
  };
  await send("Check my apps on weekdays");
  const [listed] = await client.routines.list({ botId });
  await client.routines.approve({ routineId: listed!.id });

  return {
    fake,
    reviewer,
    computerFake,
    client,
    botId,
    routine: listed!,
    send,
    fire: async () => {
      advanceTo(mondaySlot);
      await runDue();
      advanceTo("2026-10-19T10:00:00.500Z");
      await runDue();
    },
  };
}

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));

/** The results of a Turn's tool calls, by tool name (each call's id is `call-<name>`). */
function resultsOf(transcript: unknown): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const entry of transcript as ModelMessage[]) {
    if (entry.role !== "tool" || !entry.toolCallId?.startsWith("call-")) continue;
    results[entry.toolCallId.slice("call-".length)] = JSON.parse(String(entry.content));
  }
  return results;
}

/** The names of the tools a model call offered. */
const toolNames = (options: TextOptions | undefined) =>
  (options?.tools ?? []).map((tool) => tool.name).sort();

const refusedCalls = [
  call("shell", { command: "rm -rf inbox" }),
  call("start_helper", { type: "general", task: "Reply to Acme." }),
  call("check_helper", { helperId: uuidv7() }),
  call("message_helper", { helperId: uuidv7(), text: "Send it." }),
  call("stop_helpers", {}),
  call("generate_image", { prompt: "A cat" }),
  call("watch_user", { goal: "Copy the payouts.", inputs: [] }),
  call("create_routine", { ...watch, name: "another" }),
  call("update_routine", { name: "check-my-apps", prompt: "Delete my mail." }),
  call("delete_routine", { name: "check-my-apps" }),
  call("propose_rule", { text: "Send email freely.", mode: "without_asking", why: "Faster." }),
];
const refusedNames = refusedCalls.map((chunks) => {
  const start = chunks.find((chunk) => "toolCallName" in chunk) as { toolCallName: string };
  return start.toolCallName;
});

describe("a read-only Routine", () => {
  it("is stored and listed with readOnly, which is off by default", testTimeout, async () => {
    const readOnly = await approvedRoutine({ readOnly: true, rounds: [] });
    expect(readOnly.routine).toMatchObject({ name: "check-my-apps", readOnly: true });

    const plain = await approvedRoutine({ readOnly: false, rounds: [] });
    expect(plain.routine).toMatchObject({ readOnly: false });
  });

  it(
    "sends an approved Routine back for the user's OK when the Bot changes readOnly, and lists it in the system prompt",
    testTimeout,
    async () => {
      const { fake, client, botId, send } = await approvedRoutine({
        readOnly: false,
        rounds: [
          round(call("update_routine", { name: "check-my-apps", readOnly: true })),
          round(),
          round(),
        ],
      });
      await send("Make it look only");

      expect(await client.routines.list({ botId })).toEqual([
        expect.objectContaining({ readOnly: true, state: "pending", approvedAt: null }),
      ]);
      await client.routines.approve({ routineId: (await client.routines.list({ botId }))[0]!.id });
      await send("Thanks");
      const sent = JSON.stringify(fake.calls.at(-1));
      expect(sent).toContain(
        `check-my-apps  weekdays 11:00 Europe/London  \\"Look through my apps.\\" (read-only)`,
      );
    },
  );

  it("keeps the Routine's state when the user's edit changes readOnly", testTimeout, async () => {
    const { client, botId, routine } = await approvedRoutine({ readOnly: false, rounds: [] });

    await client.routines.edit({ routineId: routine.id, readOnly: true });

    expect(await client.routines.list({ botId })).toEqual([
      expect.objectContaining({ readOnly: true, state: "active" }),
    ]);
  });

  it(
    "refuses each refused tool with the read-only error before Auto-review, with the same tool list as any Turn",
    testTimeout,
    async () => {
      const { fake, reviewer, computerFake, botId, fire } = await approvedRoutine({
        readOnly: true,
        rounds: [
          round(
            ...refusedCalls,
            // A deferred tool, as the Model reaches it: through tool search.
            call("run_tool", { name: "generate_image", args: { prompt: "A dog" } }),
          ),
          round(),
        ],
      });
      await fire();

      const turns = await turnsOf(botId);
      expect(turns).toHaveLength(2);
      const results = resultsOf(turns[1]!.transcript);
      expect(Object.keys(results).sort()).toEqual([...refusedNames, "run_tool"].sort());
      for (const name of [...refusedNames, "run_tool"]) {
        expect({ name, result: results[name] }).toEqual({ name, result: { error: readOnlyError } });
      }
      // Nothing reached Auto-review, the Computer's shell, or an Approval.
      expect(reviewer.calls).toEqual([]);
      expect(computerFake.callsOf("run").map((run) => run.command)).not.toContain("rm -rf inbox");
      expect(await getTestDb().select().from(botReview).where(eq(botReview.botId, botId))).toEqual(
        [],
      );
      // The read-only Turn offered the same tools as the Turn that created the Routine.
      expect(toolNames(fake.calls[2])).toEqual(toolNames(fake.calls[0]));
      expect(toolNames(fake.calls[2])).toEqual(expect.arrayContaining(["shell", "start_helper"]));
    },
  );

  it("lets the allowed tools work in a read-only run", testTimeout, async () => {
    const { client, botId, fire } = await approvedRoutine({
      readOnly: true,
      rounds: [
        round(
          call("send_to_user", { text: "Acme replied.", endTurn: false }),
          call("web_search", { query: "acme news" }),
          call("set_check_in", { at: "2026-10-22T09:00:00+01:00", note: "Has Acme paid?" }),
          call("list_check_ins", {}),
          call("cancel_check_in", { id: uuidv7() }),
          call("write", { path: "notes/acme.md", content: "Acme replied." }),
          call("edit", { path: "notes/acme.md", oldText: "replied", newText: "wrote" }),
          call("read", { path: "notes/acme.md" }),
          call("list", {}),
        ),
        round(),
      ],
    });
    await fire();

    const results = resultsOf((await turnsOf(botId))[1]!.transcript);
    expect(Object.keys(results)).toHaveLength(9);
    for (const [name, result] of Object.entries(results)) {
      expect({ name, result }).not.toEqual({ name, result: { error: readOnlyError } });
    }
    expect(results.send_to_user).toEqual({ sent: true });
    const { messages } = await client.bots.get({ botId });
    expect(messages.map((sent) => sent.text)).toContain("Acme replied.");
  });

  it("refuses nothing in a run of a Routine that isn't read-only", testTimeout, async () => {
    const { botId, fire } = await approvedRoutine({
      readOnly: false,
      rounds: [round(call("delete_routine", { name: "check-my-apps" })), round()],
    });
    await fire();

    const results = resultsOf((await turnsOf(botId))[1]!.transcript);
    expect(results.delete_routine).toEqual({ deleted: true });
  });
});
