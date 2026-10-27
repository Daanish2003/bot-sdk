import type { TextOptions } from "@tanstack/ai";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { conversationChannel } from "@botsdk/bot/chat/conversation-events";
import type { FeatureContext } from "@botsdk/bot/feature";
import type { Transaction } from "@botsdk/bot/plugin";
import { createMemoryPubSub } from "@botsdk/bot/chat/pubsub";
import { botTurn, job, usage } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import type { HostProvider } from "@botsdk/bot/models/internal";
import { findBot } from "@botsdk/bot/bot/conversation";
import { botMemoryPassJob } from "@botsdk/memory/server/bot-pass";
import { saveCredentials, quotaLookup } from "@botsdk/bot/models/internal";

import {
  inProcessRunner,
  type JobRunner,
  systemClock,
  createWorkflow,
} from "@botsdk/bot/runner/internal";

import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, runError, text, withUsage } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../support/fake-computer-provider";
import { followSend } from "../../../support/follow-send";

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
  }: { names?: string[]; host?: boolean } & Pick<TestDepsOverrides, "getQuota"> = {},
) {
  const fake = createFakeAdapter({ rounds });
  const computerFake = fakeComputerProvider();
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
  (call?.messages ?? []).map((message) => String(message.content)).join("\n");

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
    let setup: ReturnType<typeof botsWith> extends Promise<infer T> ? T : never;
    const { client, botIds, read } = (setup = await botsWith([
      round(),
      () => {
        // The user edits line 1 while the pass is thinking.
        setup.seed(setup.botIds[0]!, "profile.md", ["- Prefers terse replies", "- Is vegetarian"]);
        return ops(
          { op: "replace", line: 1, text: "Prefers long replies" },
          { op: "remove", line: 9 },
          { op: "replace", line: 0, text: "Nope" },
          { op: "remove", line: 2 },
        );
      },
    ]));
    const [ada] = botIds as [string];
    setup.seed(ada, "profile.md", ["- Prefers short replies", "- Is vegetarian"]);

    await send(client, ada, "hi");
    await passesEnded(1);

    expect(read(ada, "profile.md")).toBe("- Prefers terse replies\n");
  });

  it("keeps a write to a file that lands while it reads another", async () => {
    let setup: ReturnType<typeof botsWith> extends Promise<infer T> ? T : never;
    const { client, botIds, read } = (setup = await botsWith([
      round(),
      () => {
        // Once the pass applies its operations, reading the Notes lets the Bot add to its Profile.
        const { provider } = setup.computerFake;
        const readFile = provider.readFile;
        provider.readFile = async (sandboxId, path) => {
          if (path === memoryPath(setup.botIds[0]!, "notes.md")) {
            const profile = setup.read(setup.botIds[0]!, "profile.md") ?? "";
            setup.computerFake.files.set(
              memoryPath(setup.botIds[0]!, "profile.md"),
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
        ...(deps.parts.jobs.get(botMemoryPassJob.name)!.services as FeatureContext<"computer">),
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

describe("a Bot with no pass", () => {
  it("queues none with Memory off", async () => {
    const { client, botIds } = await botsWith([round()]);
    await client.memory.setEnabled({ enabled: false });

    await send(client, botIds[0]!, "hi");
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await passJobs()).toHaveLength(0);
  });
});
