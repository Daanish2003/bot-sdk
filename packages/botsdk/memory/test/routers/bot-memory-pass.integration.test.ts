import type { TextOptions } from "@tanstack/ai";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assignmentEnded, defineFeature, defineJob, type FeatureContext } from "@botsdk/bot";
import { sendToUserToolName } from "@botsdk/bot/bot/context";
import { isTurnCall } from "@ai-chat/test-support/bot-turns";
import { receive } from "@botsdk/bot/bot/triggers";
import { conversationChannel } from "@botsdk/bot/chat/conversation-events";
import type { Transaction } from "@botsdk/bot/plugin";
import { createMemoryPubSub } from "@botsdk/bot/chat/pubsub";
import {
  bot,
  botAssignment,
  botTurn,
  computer,
  conversation,
  job,
  message,
  usage,
} from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { ComputerProvider } from "@botsdk/bot/computer/internal";
import type { HostProvider } from "@botsdk/bot/models/internal";
import { findBot } from "@botsdk/bot/bot/conversation";
import { botResetJobName } from "@botsdk/bot/bot/turn";
import { applyMemoryOps, botMemoryPassJob, type PassContext } from "../../src/server/bot-pass";
import { saveCredentials, quotaLookup } from "@botsdk/bot/models/internal";

import {
  inProcessRunner,
  type JobRunner,
  systemClock,
  createWorkflow,
} from "@botsdk/bot/runner/internal";

import { createTestSdk, type TestDeps, type TestDepsOverrides } from "@ai-chat/test-support/deps";
import {
  createFakeAdapter,
  type FakeAdapter,
  round,
  runError,
  text,
  toolCall,
  withUsage,
} from "@botsdk/testing/fake-adapter";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { followSend } from "@ai-chat/test-support/follow-send";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const passJob = "memory.bot-pass";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** The fake clock's "now": the pass dates its adds 2030-03-15, in the 2030-03 Log. */
const now = new Date("2030-03-15T12:00:00Z");

const hostModel = "anthropic:claude-sonnet-5-5";
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
];

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const memoryPath = (botId: string, file: string) => `/home/user/bots/${botId}/memory/${file}`;

/**
 * A user and the Bots `names` (oldest first), over an SDK with `memory()` and `computer` whose
 * Model plays `rounds`, on a clock that reads `now`. With `host`, the Bots run on the Host's Model
 * (metered); otherwise on the user's own key.
 */
async function botsWith(
  rounds: Round[],
  {
    names = ["Ada"],
    host = false,
    getQuota,
    logger,
    features,
  }: { names?: string[]; host?: boolean } & Pick<
    TestDepsOverrides,
    "getQuota" | "logger" | "features"
  > = {},
) {
  const fake = createFakeAdapter({ rounds });
  // Its `rm -rf -- '<dir>'` deletes the files under that directory, as a reset's does.
  const computerFake = fakeComputerProvider({
    onCommand: ({ command }) => {
      const dir = /^rm -rf -- '([^']+)'$/.exec(command)?.[1];
      for (const path of computerFake.files.keys()) {
        if (dir && path.startsWith(`${dir}/`)) computerFake.files.delete(path);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const pubsub = createMemoryPubSub();
  const offset = now.getTime() - Date.now();
  const clock = () => new Date(Date.now() + offset);
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: { ...systemClock, now: clock },
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    jobs,
    adapterFor: () => fake.adapter,
    clock,
    pubsub,
    ...(host && { hostProviders }),
    ...(getQuota && { getQuota }),
    ...(logger && { logger }),
    ...(features && { features }),
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  if (!host) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const botIds: string[] = [];
  for (const name of names) {
    botIds.push((await client.bots.create({ name, model: host ? hostModel : model })).id);
  }
  const seed = (botId: string, file: string, lines: string[]) =>
    computerFake.files.set(
      memoryPath(botId, file),
      new TextEncoder().encode(`${lines.join("\n")}\n`),
    );
  const read = (botId: string, file: string) => {
    const bytes = computerFake.files.get(memoryPath(botId, file));
    return bytes ? new TextDecoder().decode(bytes) : null;
  };
  return { fake, computerFake, deps, client, user, botIds, seed, read, pubsub };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text })) {
    // Read to the end of the Turn.
  }
}

/** The pass jobs queued so far. */
const passJobs = () => getTestDb().select().from(job).where(eq(job.name, passJob));

/** Waits until `count` pass jobs have ended, and returns them. */
async function passesEnded(count = 1) {
  await expect
    .poll(
      async () =>
        (
          await getTestDb()
            .select({ id: job.id })
            .from(job)
            .where(and(eq(job.name, passJob), inArray(job.status, ["succeeded", "failed"])))
        ).length,
      { timeout: 4_000 },
    )
    .toBe(count);
  return passJobs();
}

/** A round whose reply is the pass's operations. */
const ops = (...list: unknown[]) => round(text(JSON.stringify({ ops: list })));

const userTextOf = (call: TextOptions | undefined) =>
  (call?.messages ?? []).map((entry) => String(entry.content)).join("\n");

/** A wait a test holds open: it knows once something reached it, and lets that go on. */
function hold() {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: () => gate.resolve(),
    wait: () => {
      reached.resolve();
      return gate.promise;
    },
  };
}

/** Holds the Model call at `index` (from 0), which keeps its scripted round, until released. */
function holdModelCall(fake: FakeAdapter, index: number) {
  const held = hold();
  const play = fake.adapter.chatStream;
  fake.adapter.chatStream = async function* (options: TextOptions) {
    const iterator = play(options)[Symbol.asyncIterator]();
    const mine = fake.calls.length;
    const first = iterator.next();
    if (mine === index) await held.wait();
    for (let next = await first; !next.done; next = await iterator.next()) yield next.value;
  } as typeof fake.adapter.chatStream;
  return held;
}

/** Holds every write to `path` on the fake Computer until released. */
function holdWrite(provider: ComputerProvider, path: string) {
  const held = hold();
  const write = provider.writeFile;
  provider.writeFile = async (sandboxId, target, content) => {
    if (target === path) await held.wait();
    return write(sandboxId, target, content);
  };
  return held;
}

/** Takes, and at once gives back, an exclusive lock on every table the pass reads or writes. */
const lockEveryTable = () =>
  getTestDb().transaction(async (tx) => {
    await tx.execute(sql.raw("set local lock_timeout = '2s'"));
    await tx.execute(
      sql`lock table ${message}, ${botTurn}, ${bot}, ${conversation}, ${job}, ${computer}, ${usage} in access exclusive mode`,
    );
  });

const resetJobEnded = async () => {
  const [row] = await getTestDb().select().from(job).where(eq(job.name, botResetJobName));
  return row?.status === "succeeded";
};

type WorkflowOptions = Parameters<typeof createWorkflow<Transaction>>[0];
type HistoryEntry = WorkflowOptions["history"][number];

/** What runs a Turn's pass as a retry over `history`, with `saveWith` as its store's. */
function retryContext(
  deps: TestDeps,
  history: HistoryEntry[],
  saveWith: WorkflowOptions["store"]["saveWith"] = async (_entry, fn) => ({
    saved: true,
    result: await getTestDb().transaction(fn),
  }),
) {
  const workflow = createWorkflow<Transaction>({
    history,
    // Records nothing: every call runs for real, a `(tx) =>` one in a transaction.
    store: { save: async () => true, saveWith },
    now: () => now,
  });
  return {
    workflow,
    context: {
      ...(deps.parts.jobs.get(botMemoryPassJob.name)!.services as PassContext),
      ...workflow.context,
      signal: new AbortController().signal,
    },
  };
}

/** Runs Turn `turnId`'s pass as a retry over `history`. */
async function retryPass(deps: TestDeps, turnId: string, history: HistoryEntry[]) {
  const { workflow, context } = retryContext(deps, history);
  await botMemoryPassJob.run({ turnId }, context);
  expect(() => workflow.finish()).not.toThrow();
}

/** A recorded plan's history entry. */
const recordedPlan = (shown: unknown[], planned: unknown[]): HistoryEntry => ({
  seq: 1,
  kind: "activity",
  name: "memory_ops",
  result: { shown, ops: planned },
});

describe("the post-turn memory pass", () => {
  it("is queued once after a complete Turn, and not after an error Turn", async () => {
    const { client, botIds } = await botsWith([round(), ops(), round(runError("Provider down"))]);
    const [ada] = botIds as [string];

    await send(client, ada, "hi");
    expect(await passesEnded(1)).toHaveLength(1);

    await send(client, ada, "again");
    // The error Turn queued no pass.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await passJobs()).toHaveLength(1);
  });

  it("is queued after a stopped Turn", async () => {
    const { client, botIds } = await botsWith([ops()]);
    const [ada] = botIds as [string];

    // The Turn's job waits out its batch, so the stop finds it queued.
    await followSend(client, { botId: ada, id: uuidv7(), text: "hi" });
    await client.bots.stop({ botId: ada });

    expect(await passesEnded(1)).toHaveLength(1);
    const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, ada));
    expect(turn?.status).toBe("stopped");
  });

  it("shows numbered lines and the Turn, and applies add, replace and remove", async () => {
    const { client, botIds, fake, seed, read } = await botsWith([
      round(),
      ops(
        { op: "add", tier: "profile", text: "Lives in Berlin" },
        { op: "add", tier: "log", text: "Signed the lease", importance: 8 },
        { op: "add", tier: "notes", text: "Travelling until Thursday" },
        { op: "replace", line: 2, text: "Is vegan" },
        { op: "remove", line: 3 },
        { op: "replace", line: 4, text: "Met Bob for lunch" },
      ),
    ]);
    const [ada] = botIds as [string];
    seed(ada, "profile.md", ["- Prefers long replies", "- Is vegetarian"]);
    seed(ada, "notes.md", ["- 2030-03-15 Call the bank"]);
    seed(ada, "log/2030-03.md", ["- 2030-03-14 (importance 3) Met Bob"]);

    await send(client, ada, "I'm vegan now, and I signed the lease");
    await passesEnded(1);

    expect(fake.calls[1]?.threadId).toBe(ada);
    const shown = userTextOf(fake.calls[1]);
    expect(shown).toContain("I'm vegan now, and I signed the lease");
    expect(shown).toContain("1. Prefers long replies");
    expect(shown).toContain("2. Is vegetarian");
    expect(shown).toContain("3. 2030-03-15 Call the bank");
    expect(shown).toContain("4. 2030-03-14 (importance 3) Met Bob");

    expect(read(ada, "profile.md")).toBe("- Prefers long replies\n- Is vegan\n- Lives in Berlin\n");
    expect(read(ada, "notes.md")).toBe("- 2030-03-15 Travelling until Thursday\n");
    expect(read(ada, "log/2030-03.md")).toBe(
      "- 2030-03-14 (importance 3) Met Bob for lunch\n- 2030-03-15 (importance 8) Signed the lease\n",
    );
  });

  it("skips an operation citing an unshown line or one edited since", async () => {
    const { client, deps, botIds, user, seed, read } = await botsWith([round(), ops()]);
    const [ada] = botIds as [string];
    await send(client, ada, "hi");
    await passesEnded(1);
    const path = memoryPath(ada, "profile.md");
    // The Bot's own edit doesn't take the pass's lock, so it can land after the re-check.
    seed(ada, "profile.md", ["- Prefers terse replies", "- Is vegetarian"]);

    await applyMemoryOps(deps.computer!.forUser(user.id), {
      botId: ada,
      shown: [
        { tier: "profile", path, line: 1, text: "Prefers short replies", content: "" },
        { tier: "profile", path, line: 2, text: "Is vegetarian", content: "" },
      ],
      ops: [
        { op: "replace", line: 1, text: "Prefers long replies" },
        { op: "remove", line: 9 },
        { op: "replace", line: 0, text: "Nope" },
        { op: "remove", line: 2 },
      ],
      now,
    });

    expect(read(ada, "profile.md")).toBe("- Prefers terse replies\n");
  });

  it("keeps a write to a file that lands while it reads another", async () => {
    let setup: ReturnType<typeof botsWith> extends Promise<infer T> ? T : never;
    const { client, botIds, read } = (setup = await botsWith([
      round(),
      () => {
        // Once the pass has written its Profile, reading the Notes lets the Bot add to the Profile.
        const { provider } = setup.computerFake;
        const profilePath = memoryPath(setup.botIds[0]!, "profile.md");
        let wrote = false;
        const writeFile = provider.writeFile;
        provider.writeFile = async (sandboxId, path, content) => {
          if (path === profilePath) wrote = true;
          return writeFile(sandboxId, path, content);
        };
        const readFile = provider.readFile;
        provider.readFile = async (sandboxId, path) => {
          if (wrote && path === memoryPath(setup.botIds[0]!, "notes.md")) {
            const profile = setup.read(setup.botIds[0]!, "profile.md") ?? "";
            setup.computerFake.files.set(
              profilePath,
              new TextEncoder().encode(`${profile}- Likes jazz\n`),
            );
          }
          return readFile(sandboxId, path);
        };
        return ops(
          { op: "add", tier: "profile", text: "Lives in Berlin" },
          { op: "add", tier: "notes", text: "Travelling until Thursday" },
        );
      },
    ]));
    const [ada] = botIds as [string];
    setup.seed(ada, "profile.md", ["- Prefers short replies"]);

    await send(client, ada, "hi");
    await passesEnded(1);

    expect(read(ada, "profile.md")).toContain("- Likes jazz\n");
    expect(read(ada, "profile.md")).toContain("- Lives in Berlin\n");
  });

  it("never writes another Bot's files", async () => {
    const { client, botIds, seed, computerFake, read } = await botsWith(
      [
        round(),
        ops({ op: "add", tier: "profile", text: "Lives in Berlin" }, { op: "remove", line: 2 }),
      ],
      { names: ["Ada", "Bea"] },
    );
    const [ada, bea] = botIds as [string, string];
    seed(ada, "profile.md", ["- Prefers short replies"]);
    seed(bea, "profile.md", ["- Works at a bakery"]);
    const before = new Map(computerFake.files);

    await send(client, ada, "hi");
    await passesEnded(1);

    expect(read(bea, "profile.md")).toBe("- Works at a bakery\n");
    expect(read(ada, "profile.md")).toBe("- Prefers short replies\n- Lives in Berlin\n");
    const changed = [...computerFake.files.keys()].filter(
      (path) => computerFake.files.get(path) !== before.get(path),
    );
    expect(changed.every((path) => path.startsWith(`/home/user/bots/${ada}/memory/`))).toBe(true);
  });

  it("changes nothing on invalid output", async () => {
    const { client, botIds, seed, read } = await botsWith([
      round(),
      round(text("Sure! I'll remember that.")),
      round(),
      ops({ op: "add", tier: "profile", text: "Lives in Berlin" }, { op: "explode", line: 1 }),
    ]);
    const [ada] = botIds as [string];
    seed(ada, "profile.md", ["- Prefers short replies"]);

    await send(client, ada, "hi");
    await passesEnded(1);
    await send(client, ada, "again");
    const ended = await passesEnded(2);

    expect(ended.every((row) => row.status === "succeeded")).toBe(true);
    expect(read(ada, "profile.md")).toBe("- Prefers short replies\n");
  });

  it("logs a reply with no valid JSON, and changes nothing", async () => {
    const logger = { error: vi.fn() };
    const { client, botIds, seed, read } = await botsWith(
      [round(), round(text("Sure! I'll remember that."))],
      { logger },
    );
    const [ada] = botIds as [string];
    seed(ada, "profile.md", ["- Prefers short replies"]);

    await send(client, ada, "hi");
    const [ended] = await passesEnded(1);

    expect(ended?.status).toBe("succeeded");
    expect(read(ada, "profile.md")).toBe("- Prefers short replies\n");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/^The memory pass of Turn .+ changed nothing$/),
      expect.any(SyntaxError),
    );
  });

  it.each([
    ["its JSON", (json: string) => `${json}\nI added that to your profile.`],
    ["its fenced JSON", (json: string) => `\`\`\`json\n${json}\n\`\`\`\n\nI added that {profile}.`],
  ])("applies the operations of a reply with text after %s", async (_shape, replyOf) => {
    const add = { op: "add", tier: "profile", text: "Lives in Berlin {or so}" };
    const { client, botIds, read } = await botsWith([
      round(),
      round(text(replyOf(JSON.stringify({ ops: [add] })))),
    ]);
    const [ada] = botIds as [string];

    await send(client, ada, "hi");
    await passesEnded(1);

    expect(read(ada, "profile.md")).toBe("- Lives in Berlin {or so}\n");
  });

  it("clamps an importance out of range, and takes 5 for a null one", async () => {
    const { client, botIds, read } = await botsWith([
      round(),
      ops(
        { op: "add", tier: "log", text: "Lost a sock", importance: 0 },
        { op: "add", tier: "log", text: "Got married", importance: 12 },
        { op: "add", tier: "log", text: "Bought bread", importance: null },
      ),
    ]);
    const [ada] = botIds as [string];

    await send(client, ada, "hi");
    await passesEnded(1);

    expect(read(ada, "log/2030-03.md")).toBe(
      "- 2030-03-15 (importance 1) Lost a sock\n" +
        "- 2030-03-15 (importance 10) Got married\n" +
        "- 2030-03-15 (importance 5) Bought bread\n",
    );
  });

  it("refuses Profile adds and replaces past the cap, and a line that reads as a heading", async () => {
    const { client, botIds, seed, read } = await botsWith([
      round(),
      ops(
        { op: "add", tier: "profile", text: "One too many" },
        { op: "replace", line: 1, text: "x".repeat(4_000) },
        { op: "add", tier: "notes", text: "#1 priority is the visa" },
      ),
    ]);
    const [ada] = botIds as [string];
    const full = Array.from({ length: 100 }, (_, i) => `- Fact ${i + 1}`);
    seed(ada, "profile.md", full);

    await send(client, ada, "hi");
    await passesEnded(1);

    expect(read(ada, "profile.md")).toBe(`${full.join("\n")}\n`);
    expect(read(ada, "notes.md")).toBeNull();
  });

  it("records its usage as memory on Host credentials", async () => {
    const usageOfCall = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    const { client, botIds, user } = await botsWith([round(), withUsage(ops(), usageOfCall)], {
      host: true,
    });

    await send(client, botIds[0]!, "hi");
    await passesEnded(1);

    const rows = await getTestDb().select().from(usage).where(eq(usage.userId, user.id));
    expect(rows.map((row) => row.kind).sort()).toEqual(["memory", "turn"]);
    expect(rows.find((row) => row.kind === "memory")).toMatchObject({
      model: hostModel,
      inputTokens: 100,
      outputTokens: 10,
    });
  });

  it("is skipped once the Turn has spent the Quota", async () => {
    const usageOfCall = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    // 200 micros a day; the Turn spends 450.
    const { client, botIds, fake, seed, read } = await botsWith(
      [
        withUsage(round(), usageOfCall),
        ops({ op: "add", tier: "profile", text: "Lives in Berlin" }),
      ],
      { host: true, getQuota: quotaLookup({ budgetUsd: 0.0002, window: "day" }) },
    );
    const [ada] = botIds as [string];
    seed(ada, "profile.md", ["- Prefers short replies"]);

    await send(client, ada, "hi");
    await passesEnded(1);

    expect(fake.calls).toHaveLength(1);
    expect(read(ada, "profile.md")).toBe("- Prefers short replies\n");
  });

  it("applies the recorded operations on a retry, even once the Quota is spent", async () => {
    const usageOfCall = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    // 200 micros a day; the Turn spends 450, so the Quota is spent by the retry.
    const { client, botIds, deps, read } = await botsWith([withUsage(round(), usageOfCall)], {
      host: true,
      getQuota: quotaLookup({ budgetUsd: 0.0002, window: "day" }),
    });
    const [ada] = botIds as [string];
    await send(client, ada, "I live in Berlin");
    await passesEnded(1);
    const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, ada));

    // A retry of an attempt that recorded its operations, then failed before applying them.
    const workflow = createWorkflow<Transaction>({
      history: [
        {
          seq: 1,
          kind: "activity",
          name: "memory_ops",
          result: { shown: [], ops: [{ op: "add", tier: "profile", text: "Lives in Berlin" }] },
        },
      ],
      // Records nothing: every call runs for real, a `(tx) =>` one in a transaction.
      store: {
        save: async () => true,
        saveWith: async (_entry, fn) => ({
          saved: true,
          result: await getTestDb().transaction(fn),
        }),
      },
      now: () => now,
    });
    await botMemoryPassJob.run(
      { turnId: turn!.id },
      {
        ...(deps.parts.jobs.get(botMemoryPassJob.name)!.services as PassContext),
        ...workflow.context,
        signal: new AbortController().signal,
      },
    );

    expect(() => workflow.finish()).not.toThrow();
    expect(read(ada, "profile.md")).toBe("- Lives in Berlin\n");
  });

  it("saves the Turn's change list and records a turn change, hinting without data", async () => {
    const { client, botIds, seed, pubsub, user } = await botsWith([
      round(),
      ops(
        { op: "add", tier: "log", text: "Moved to Berlin", importance: 7 },
        { op: "replace", line: 1, text: "Is vegan" },
        { op: "remove", line: 2 },
      ),
    ]);
    const [ada] = botIds as [string];
    seed(ada, "profile.md", ["- Is vegetarian", "- Likes jazz"]);
    const { conversationId } = (await findBot(getTestDb(), user.id, ada))!;
    const events: { type?: string }[] = [];
    await pubsub.subscribe(conversationChannel(conversationId), (message) => {
      events.push(JSON.parse(message) as { type?: string });
    });
    const before = (await client.bots.get({ botId: ada })).lastSeq;

    await send(client, ada, "I moved to Berlin and I'm vegan now");
    await passesEnded(1);

    const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, ada));
    const changes = [
      { kind: "remembered", tier: "log", text: "Moved to Berlin" },
      { kind: "changed", tier: "profile", from: "Is vegetarian", text: "Is vegan" },
      { kind: "forgot", tier: "profile", text: "Likes jazz" },
    ];
    expect(turn?.memoryChanges).toEqual(changes);
    // The pass records a `turn` change after the Turn's own, so a synced tab re-reads the chip.
    const logged = await client.conversations.changes({ conversationId, since: before });
    expect(logged.reload).toBe(false);
    const turnChanges = logged.reload
      ? []
      : logged.changes.filter((change) => change.kind === "turn" && change.refId === turn!.id);
    expect(turnChanges.map((change) => change.seq)).toHaveLength(4); // the Turn's start and end, then the memory pass
    const lastTurnChange = turnChanges.at(-1)!;
    const lastSeq = (await client.bots.get({ botId: ada })).lastSeq;
    expect(lastTurnChange.seq).toBe(lastSeq);
    // No event carries data (ADR 0026), and the last one is a bare hint.
    await expect.poll(() => events.at(-1), { timeout: 10_000 }).toEqual({ type: "changed" });
    expect(events.every((event) => event.type === "changed")).toBe(true);

    // A reload reads the list from the Conversation read, with the Conversation's id for the stream.
    const read = await client.bots.get({ botId: ada });
    expect(read.conversationId).toBe(conversationId);
    expect(read.turns.map((t) => t.memoryChanges)).toEqual([changes]);
  }, 30_000);

  it("saves no change list when nothing changed", async () => {
    const { client, botIds } = await botsWith([round(), ops()]);
    const [ada] = botIds as [string];

    await send(client, ada, "hi");
    await passesEnded(1);

    const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, ada));
    expect(turn?.memoryChanges).toBeNull();
    expect((await client.bots.get({ botId: ada })).turns.map((t) => t.memoryChanges)).toEqual([
      null,
    ]);
  });
});

describe("a pass holds no lock across its Model call, and re-checks what it planned from", () => {
  const timeout = 30_000;

  it("lets an exclusive lock through while it waits on its Model", { timeout }, async () => {
    const { client, botIds, fake, read } = await botsWith([
      round(),
      ops({ op: "add", tier: "profile", text: "Lives in Berlin" }),
    ]);
    const held = holdModelCall(fake, 1);

    await send(client, botIds[0]!, "hi");
    await held.reached;
    try {
      await lockEveryTable();
    } finally {
      held.release();
    }

    await passesEnded(1);
    expect(read(botIds[0]!, "profile.md")).toBe("- Lives in Berlin\n");
  });

  it(
    "lets an exclusive lock through while the Computer holds up its write",
    { timeout },
    async () => {
      const { client, botIds, computerFake, read } = await botsWith([
        round(),
        ops({ op: "add", tier: "profile", text: "Lives in Berlin" }),
      ]);
      const [ada] = botIds as [string];
      const held = holdWrite(computerFake.provider, memoryPath(ada, "profile.md"));

      await send(client, ada, "hi");
      await held.reached;
      try {
        await lockEveryTable();
      } finally {
        held.release();
      }

      await passesEnded(1);
      expect(read(ada, "profile.md")).toBe("- Lives in Berlin\n");
    },
  );

  it("plans again from what an earlier pass wrote during its Model call", { timeout }, async () => {
    const { client, botIds, fake, seed, read } = await botsWith([
      round(),
      // The first pass, shown both lines: line 2 is the one it means.
      ops({ op: "replace", line: 2, text: "Is vegan" }),
      round(),
      // The second pass overtakes it, and moves that line up.
      ops({ op: "remove", line: 1 }),
      // The first pass again, shown the new numbers.
      ops({ op: "replace", line: 1, text: "Is vegan" }),
    ]);
    const [ada] = botIds as [string];
    seed(ada, "profile.md", ["- Prefers short replies", "- Is vegetarian"]);
    const held = holdModelCall(fake, 1);

    await send(client, ada, "hi");
    await held.reached;
    try {
      await send(client, ada, "again");
      await passesEnded(1);
      expect(read(ada, "profile.md")).toBe("- Is vegetarian\n");
    } finally {
      held.release();
    }

    await passesEnded(2);
    expect(fake.calls).toHaveLength(5);
    expect(userTextOf(fake.calls[4])).toContain("1. Is vegetarian");
    expect(userTextOf(fake.calls[4])).not.toContain("Prefers short replies");
    expect(read(ada, "profile.md")).toBe("- Is vegan\n");
  });

  it("bills the plan it threw away", { timeout }, async () => {
    const usageOfCall = { promptTokens: 100, completionTokens: 10, totalTokens: 110 };
    let setup: ReturnType<typeof botsWith> extends Promise<infer T> ? T : never;
    const { client, botIds, user, read } = (setup = await botsWith(
      [
        round(),
        () => {
          setup.seed(setup.botIds[0]!, "profile.md", ["- Prefers terse replies"]);
          return withUsage(ops({ op: "replace", line: 1, text: "Stale" }), usageOfCall);
        },
        withUsage(ops({ op: "add", tier: "notes", text: "Asked about replies" }), usageOfCall),
      ],
      { host: true },
    ));
    const [ada] = botIds as [string];
    setup.seed(ada, "profile.md", ["- Prefers short replies"]);

    await send(client, ada, "hi");
    await passesEnded(1);

    const rows = await getTestDb().select().from(usage).where(eq(usage.userId, user.id));
    expect(rows.filter((row) => row.kind === "memory")).toHaveLength(2);
    expect(read(ada, "profile.md")).toBe("- Prefers terse replies\n");
    expect(read(ada, "notes.md")).toBe("- 2030-03-15 Asked about replies\n");
  });

  it("gives up with a log after three plans that went stale", { timeout }, async () => {
    const logger = { error: vi.fn() };
    let setup: ReturnType<typeof botsWith> extends Promise<infer T> ? T : never;
    let edits = 0;
    const stale = () => {
      edits += 1;
      setup.seed(setup.botIds[0]!, "profile.md", [`- Edit ${edits}`]);
      return ops({ op: "replace", line: 1, text: "Stale" });
    };
    const { client, botIds, fake, read } = (setup = await botsWith([round(), stale, stale, stale], {
      logger,
    }));
    const [ada] = botIds as [string];

    await send(client, ada, "hi");
    const [ended] = await passesEnded(1);

    expect(ended?.status).toBe("succeeded");
    expect(fake.calls).toHaveLength(4);
    expect(read(ada, "profile.md")).toBe("- Edit 3\n");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/^The memory pass of Turn .+ changed nothing: .+/),
    );
  });

  it(
    "doesn't plan again when it planned nothing, though its lines changed",
    { timeout },
    async () => {
      let setup: ReturnType<typeof botsWith> extends Promise<infer T> ? T : never;
      const { client, botIds, fake } = (setup = await botsWith([
        round(),
        () => {
          setup.seed(setup.botIds[0]!, "profile.md", ["- Prefers terse replies"]);
          return ops();
        },
      ]));

      await send(client, botIds[0]!, "hi");
      await passesEnded(1);

      expect(fake.calls).toHaveLength(2);
    },
  );

  it("takes a line with a NUL, which its Checkpoint drops, as unchanged", { timeout }, async () => {
    const { client, botIds, fake, computerFake, read } = await botsWith([
      round(),
      ops({ op: "add", tier: "notes", text: "Asked about jazz" }),
    ]);
    const [ada] = botIds as [string];
    computerFake.files.set(
      memoryPath(ada, "profile.md"),
      new TextEncoder().encode("- Likes\0 jazz\n"),
    );

    await send(client, ada, "hi");
    await passesEnded(1);

    expect(fake.calls).toHaveLength(2);
    expect(read(ada, "notes.md")).toBe("- 2030-03-15 Asked about jazz\n");
  });

  describe("a reset", () => {
    it("during its Model call goes through, and the pass writes nothing", { timeout }, async () => {
      const { client, botIds, fake, read } = await botsWith([
        round(),
        ops({ op: "add", tier: "profile", text: "Lives in Berlin" }),
      ]);
      const [ada] = botIds as [string];
      const held = holdModelCall(fake, 1);

      await send(client, ada, "hi");
      await held.reached;
      try {
        await client.bots.reset({ botId: ada, name: "Ada" });
        await expect.poll(resetJobEnded, { timeout: 4_000 }).toBe(true);
      } finally {
        held.release();
      }

      await passesEnded(1);
      expect(read(ada, "profile.md")).toBeNull();
    });

    it("waits for a write in flight, and deletes what it wrote", { timeout }, async () => {
      const { client, botIds, computerFake, read } = await botsWith([
        round(),
        ops({ op: "add", tier: "profile", text: "Lives in Berlin" }),
      ]);
      const [ada] = botIds as [string];
      const held = holdWrite(computerFake.provider, memoryPath(ada, "profile.md"));

      await send(client, ada, "hi");
      await held.reached;
      try {
        await client.bots.reset({ botId: ada, name: "Ada" });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await resetJobEnded()).toBe(false);
      } finally {
        held.release();
      }

      await expect.poll(resetJobEnded, { timeout: 4_000 }).toBe(true);
      expect(read(ada, "profile.md")).toBeNull();
    });
  });

  describe("a retry", () => {
    /** A Bot past its Turn and its first pass, with the Profile `lines`. */
    async function pastItsPass(rounds: Round[], lines: string[]) {
      const setup = await botsWith([round(), ops(), ...rounds]);
      const [ada] = setup.botIds as [string];
      await send(setup.client, ada, "hi");
      await passesEnded(1);
      if (lines.length > 0) setup.seed(ada, "profile.md", lines);
      const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, ada));
      // As `jsonb` hands a shown line back: not in the order it was written.
      const shownProfile = (line: number, text: string) => ({
        line,
        path: memoryPath(ada, "profile.md"),
        text,
        tier: "profile",
        content: text,
      });
      return { ...setup, ada, turnId: turn!.id, shownProfile };
    }

    it("applies a recorded plan with no second Model call", { timeout }, async () => {
      const { deps, fake, read, ada, turnId, shownProfile } = await pastItsPass(
        [],
        ["- Is vegetarian"],
      );

      await retryPass(deps, turnId, [
        recordedPlan(
          [shownProfile(1, "Is vegetarian")],
          [{ op: "replace", line: 1, text: "Is vegan" }],
        ),
      ]);

      expect(fake.calls).toHaveLength(2);
      expect(read(ada, "profile.md")).toBe("- Is vegan\n");
    });

    it("doesn't apply twice once its apply is recorded", { timeout }, async () => {
      const { deps, fake, read, ada, turnId, shownProfile } = await pastItsPass(
        [],
        ["- Is vegetarian"],
      );

      await retryPass(deps, turnId, [
        recordedPlan(
          [shownProfile(1, "Is vegetarian")],
          [{ op: "replace", line: 1, text: "Is vegan" }],
        ),
        { seq: 2, kind: "activity", name: "memory_apply", result: [] },
      ]);

      expect(fake.calls).toHaveLength(2);
      expect(read(ada, "profile.md")).toBe("- Is vegetarian\n");
    });

    it("plans again when its recorded plan has gone stale", { timeout }, async () => {
      const { deps, fake, read, ada, turnId, shownProfile } = await pastItsPass(
        [ops({ op: "replace", line: 1, text: "Is vegan" })],
        ["- Is vegetarian"],
      );

      await retryPass(deps, turnId, [
        recordedPlan(
          [shownProfile(1, "Likes jazz"), shownProfile(2, "Is vegetarian")],
          [{ op: "replace", line: 2, text: "Is vegan" }],
        ),
      ]);

      expect(fake.calls).toHaveLength(3);
      expect(userTextOf(fake.calls[2])).toContain("1. Is vegetarian");
      expect(read(ada, "profile.md")).toBe("- Is vegan\n");
    });

    it("writes nothing when a stale recorded plan meets Memory off", { timeout }, async () => {
      const { deps, client, fake, read, ada, turnId, shownProfile } = await pastItsPass(
        [],
        ["- Is vegetarian"],
      );
      await client.memory.setEnabled({ enabled: false });

      await retryPass(deps, turnId, [
        recordedPlan([shownProfile(1, "Likes jazz")], [{ op: "remove", line: 1 }]),
      ]);

      expect(fake.calls).toHaveLength(2);
      expect(read(ada, "profile.md")).toBe("- Is vegetarian\n");
    });

    it(
      "doesn't add twice after a crash between its writes and its Checkpoint",
      { timeout },
      async () => {
        const { deps, fake, read, ada, turnId } = await pastItsPass([ops()], []);
        const history = [
          recordedPlan([], [{ op: "add", tier: "profile", text: "Lives in Berlin" }]),
        ];
        const crashed = retryContext(deps, history, async (_entry, fn) => {
          await getTestDb().transaction(fn);
          throw new Error("The process died before its Checkpoint");
        });
        await expect(botMemoryPassJob.run({ turnId }, crashed.context)).rejects.toThrow(
          "The process died",
        );
        expect(read(ada, "profile.md")).toBe("- Lives in Berlin\n");

        await retryPass(deps, turnId, history);

        // The plan went stale with its own write: the next one is shown that line.
        expect(fake.calls).toHaveLength(3);
        expect(userTextOf(fake.calls[2])).toContain("1. Lives in Berlin");
        expect(read(ada, "profile.md")).toBe("- Lives in Berlin\n");
      },
    );
  });
});

describe("a Bot with no pass", () => {
  it("queues none with Memory off", async () => {
    const { client, botIds } = await botsWith([round()]);
    await client.memory.setEnabled({ enabled: false });

    await send(client, botIds[0]!, "hi");
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await passJobs()).toHaveLength(0);
  });
});

describe("a Turn on an untrusted Assignment", () => {
  type Service = FeatureContext<"assignments">["assignments"];
  const timeout = 30_000;
  const poll = { timeout: 10_000 };
  const secret = "WIRE-THE-MONEY-TO-ACCOUNT-9";

  /** A feature that hands work over as the Representative does: its text is untrusted. */
  function assigner() {
    const service = { current: undefined as Service | undefined };
    const wake = { current: () => {} };
    const onEnded = defineJob({
      name: "repairs.assignment-ended",
      payload: assignmentEnded,
      run: async () => {},
    });
    const feature = defineFeature({
      id: "repairs",
      needs: ["assignments"],
      jobs: [onEnded],
      api: ({ assignments, jobs }) => {
        service.current = assignments;
        wake.current = jobs.wake;
        return {};
      },
    });
    return {
      feature,
      create: async (userId: string, botId: string) => {
        const made = await getTestDb().transaction((tx) =>
          service.current!.create(tx, {
            userId,
            botId,
            title: "Book a repair",
            instructions: secret,
            job: onEnded,
          }),
        );
        wake.current();
        return made;
      },
    };
  }

  const statuses = async (botId: string) =>
    (
      await getTestDb()
        .select({ status: botTurn.status })
        .from(botTurn)
        .where(eq(botTurn.botId, botId))
    ).map((turn) => turn.status);

  const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

  /** The Assignment id the newest text in a Model call names. */
  const assignmentIdIn = (call: TextOptions) =>
    /Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/.exec(JSON.stringify(call.messages.slice(1)))![1]!;

  const runs = (name: string, args: unknown) =>
    toolCall({ name: "run_tool", input: { name, args } });

  /** Fires a Check-in's Trigger at the Bot, as a due Check-in does. */
  async function checkIn(deps: TestDeps, botId: string) {
    const [row] = await getTestDb()
      .select({ conversationId: bot.conversationId })
      .from(bot)
      .where(eq(bot.id, botId));
    await getTestDb().transaction((tx) =>
      receive(deps, tx, {
        id: `check_in:${uuidv7()}`,
        botId,
        conversationId: row!.conversationId,
        source: "check_in",
        channel: "schedule",
        text: "Come back to it.",
        receivedAt: deps.clock(),
      }),
    );
    deps.runner.wake();
  }

  it(
    "queues no pass for a Turn that took only the Assignment's Trigger",
    async () => {
      const made = assigner();
      const { user, botIds, fake } = await botsWith([round()], {
        features: [made.feature],
      });
      const [ada] = botIds as [string];

      await made.create(user.id, ada);
      await expect.poll(() => statuses(ada), poll).toEqual(["complete"]);
      await settle();

      expect(await passJobs()).toHaveLength(0);
      expect(fake.calls).toHaveLength(1);
    },
    timeout,
  );

  it(
    "gives a mixed Turn's pass the user's lines and none of the Assignment's or the Bot's",
    async () => {
      const made = assigner();
      const { client, user, botIds, fake } = await botsWith(
        [
          (call) =>
            round(
              runs("finish_assignment", {
                id: assignmentIdIn(call),
                status: "done",
                outcome: "OUTCOME-WITH-DETAILS",
              }),
            ),
          round(text("BOT-SAID-THIS")),
          ops(),
        ],
        { features: [made.feature] },
      );
      const [ada] = botIds as [string];

      await followSend(client, { botId: ada, id: uuidv7(), text: "I like oat milk" });
      await made.create(user.id, ada);
      await passesEnded(1);

      expect(await statuses(ada)).toEqual(["complete"]);
      const shown = userTextOf(fake.calls.at(-1));
      expect(shown).toContain("I like oat milk");
      expect(shown).not.toContain(secret);
      expect(shown).not.toContain("Book a repair");
      expect(shown).not.toContain("OUTCOME-WITH-DETAILS");
      expect(shown).not.toContain("BOT-SAID-THIS");
      expect(shown).not.toContain("finish_assignment");
    },
    timeout,
  );

  it(
    "runs no pass for a later Check-in Turn, nor for a Turn on a child Assignment",
    async () => {
      const made = assigner();
      const { deps, user, botIds } = await botsWith(
        [
          round(
            runs("assign_work", { bot: "Bea", title: "Pass it on", instructions: "Pass it on." }),
          ),
          round(),
          round(),
          round(),
        ],
        { names: ["Ada", "Bea"], features: [made.feature] },
      );
      const [ada, bea] = botIds as [string, string];

      await made.create(user.id, ada);
      await expect.poll(async () => (await statuses(bea)).length, poll).toBe(1);
      await expect.poll(async () => (await statuses(ada)).length, poll).toBe(1);
      await checkIn(deps, ada);
      await expect.poll(async () => (await statuses(ada)).length, poll).toBe(2);
      await expect.poll(() => statuses(ada), poll).toEqual(["complete", "complete"]);
      expect(await statuses(bea)).toEqual(["complete"]);
      await settle();

      expect(await passJobs()).toHaveLength(0);
    },
    timeout,
  );

  /** A round per call, chosen by what the call is: a Turn's by `turnRound`, a pass's by `ops()`. */
  const dispatch = (turnRound: (call: TextOptions) => ReturnType<typeof round>) =>
    Array.from(
      { length: 12 },
      () => (call: TextOptions) => (isTurnCall(call) ? turnRound(call) : ops()),
    );

  it(
    "runs a pass with the Bot's lines for a Turn on a trusted Assignment",
    async () => {
      const { client, botIds, fake } = await botsWith(
        dispatch((call) => {
          const read = JSON.stringify(call.messages);
          if (call.messages.some((entry) => entry.role === "tool")) return round();
          return read.includes("Your name: Bea")
            ? round(toolCall({ name: sendToUserToolName, input: { text: "BEA-SAID-THIS" } }))
            : round(
                runs("assign_work", {
                  bot: "Bea",
                  title: "Trusted job",
                  instructions: "TRUSTED-INSTRUCTIONS",
                }),
              );
        }),
        { names: ["Ada", "Bea"] },
      );
      const [ada, bea] = botIds as [string, string];

      await send(client, ada, "Ask Bea to do it");
      await expect
        .poll(
          () =>
            fake.calls.filter(
              (call) =>
                !isTurnCall(call) &&
                userTextOf(call).includes("TRUSTED-INSTRUCTIONS") &&
                userTextOf(call).includes("BEA-SAID-THIS"),
            ).length,
          poll,
        )
        .toBe(1);
      expect(await statuses(bea)).toEqual(["complete"]);
    },
    timeout,
  );

  it(
    "runs no pass for a Check-in Turn that finishes the Assignment",
    async () => {
      const made = assigner();
      const { deps, user, botIds } = await botsWith(
        dispatch((call) =>
          JSON.stringify(call.messages).includes("Come back to it.") &&
          !call.messages.some((entry) => entry.role === "tool")
            ? round(
                runs("finish_assignment", {
                  id: assignmentIdIn(call),
                  status: "done",
                  outcome: "OUTCOME-WITH-DETAILS",
                }),
              )
            : round(),
        ),
        { features: [made.feature] },
      );
      const [ada] = botIds as [string];

      await made.create(user.id, ada);
      await expect.poll(() => statuses(ada), poll).toEqual(["complete"]);
      await checkIn(deps, ada);
      await expect.poll(() => statuses(ada), poll).toEqual(["complete", "complete"]);
      const [assignment] = await getTestDb().select().from(botAssignment);
      expect(assignment?.status).toBe("done");
      await settle();

      expect(await passJobs()).toHaveLength(0);
    },
    timeout,
  );

  it(
    "still runs a pass with the Bot's lines for a Turn of only the user's Message",
    async () => {
      const { client, botIds, fake } = await botsWith([round(text("BOT-SAID-THIS")), ops()]);
      const [ada] = botIds as [string];

      await send(client, ada, "I like oat milk");
      await passesEnded(1);

      expect(userTextOf(fake.calls[1])).toContain("I like oat milk");
      expect(userTextOf(fake.calls[1])).toContain("BOT-SAID-THIS");
    },
    timeout,
  );
});
