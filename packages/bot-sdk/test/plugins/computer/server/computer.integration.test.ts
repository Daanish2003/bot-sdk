import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { postgresBlobStore } from "../../../../core/server/blob/postgres";
import type { BlobStore } from "../../../../core/server/blob/store";
import { botTurn, computer as computerTable, job } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { createBot } from "../../../../plugins/bot/server/store";
import {
  computer,
  ComputerUnavailableError,
  syncCapBytes,
} from "../../../../plugins/computer/server/plugin";
import type { CommandResult } from "../../../../plugins/computer/server/provider";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { drainJobs } from "../../../support/jobs";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider, type FakeCommand } from "./fake-provider";

const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

const minuteMs = 60_000;

/**
 * An SDK with `computer` on over a fake provider, on a clock the test sets through `now`. It
 * starts at the real time, since a failed job's retry is due by the real time plus its backoff.
 */
function sdkWith({
  onCommand,
  onPause,
  withBot = false,
}: {
  onCommand?: (command: FakeCommand) => CommandResult | Promise<CommandResult>;
  onPause?: (sandboxId: string) => void | Promise<void>;
  /** Turns `bot` on too, listed first, so its busy check must not depend on the order. */
  withBot?: boolean;
} = {}) {
  const clock = { now: new Date() };
  const fake = fakeComputerProvider({ onCommand, onPause });
  const blobs = testBlobStore();
  const logged: unknown[][] = [];
  const sdk = createTestSdk({
    plugins: [...(withBot ? [bot()] : []), computer({ provider: fake.provider })],
    clock: () => clock.now,
    blobStore: blobs.store,
    logger: { error: (...args: unknown[]) => logged.push(args) },
  });
  return { sdk, fake, clock, blobs, logged };
}

/** The test database's blob store, recording each put, with `put` and `get` made to fail on demand. */
function testBlobStore() {
  const inner = postgresBlobStore(getTestDb());
  const puts: string[] = [];
  const failing = new Set<"put" | "get">();
  const failIfTold = (call: "put" | "get") => {
    if (failing.has(call)) throw new Error(`The blob store was told to fail ${call}`);
  };
  const store: BlobStore = {
    put: async (key, bytes, options) => {
      failIfTold("put");
      puts.push(key);
      await inner.put(key, bytes, options);
    },
    get: async (key) => {
      failIfTold("get");
      return inner.get(key);
    },
    delete: (keys) => inner.delete(keys),
  };
  return { store, puts, failing, stored: (key: string) => inner.get(key) };
}

const computerRow = async (userId: string) =>
  (await getTestDb().select().from(computerTable).where(eq(computerTable.userId, userId)))[0];

/** `ms` after `time`. */
const after = (time: Date, ms: number) => new Date(time.getTime() + ms);

/** Runs the jobs due by `now`, as the runner would at that time, with `sdk` as their deps. */
const runDueJobs = (sdk: TestDeps, now: Date) =>
  drainJobs({ deps: sdk, respectRunAfter: true, now });

/** When each queued sleep check is due, in order. */
const queuedChecks = async () =>
  (
    await getTestDb()
      .select({ runAfter: job.runAfter })
      .from(job)
      .where(and(eq(job.name, "computer.sleep"), eq(job.status, "queued")))
      .orderBy(asc(job.runAfter))
  ).map((row) => row.runAfter);

describe("forUser(userId).run", () => {
  it("creates the row and the sandbox on the user's first operation", async () => {
    const { sdk, fake, clock } = sdkWith();
    const user = await insertUser();
    expect(await computerRow(user.id)).toBeUndefined();

    await sdk.plugin("computer").forUser(user.id).run("true");

    const [created] = fake.callsOf("create");
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(await computerRow(user.id)).toEqual({
      userId: user.id,
      sandboxId: created?.sandboxId,
      template: "fake-computer-v1",
      state: "awake",
      lastActiveAt: clock.now,
      createdAt: clock.now,
      syncedAt: null,
      syncFingerprint: null,
      syncedBytes: null,
    });
  });

  it("records activity when the command starts and again when it finishes", async () => {
    const started = new Date("2026-10-18T11:00:00Z");
    const finished = new Date("2026-10-18T11:03:00Z");
    let duringCommand: Date | undefined;
    const { sdk, clock } = sdkWith({
      onCommand: async () => {
        duringCommand = (await computerRow(user.id))?.lastActiveAt;
        clock.now = finished;
        return ok;
      },
    });
    const user = await insertUser();
    await sdk.plugin("computer").forUser(user.id).run("true");
    clock.now = started;

    await sdk.plugin("computer").forUser(user.id).run("sleep 180");

    expect(duringCommand).toEqual(started);
    expect((await computerRow(user.id))?.lastActiveAt).toEqual(finished);
  });

  it("returns the command's exit code and output, and runs where it is told", async () => {
    const { sdk, fake } = sdkWith({
      onCommand: () => ({ exitCode: 1, stdout: "out", stderr: "err" }),
    });
    const user = await insertUser();

    const result = await sdk.plugin("computer").forUser(user.id).run("false", { cwd: "/tmp" });

    expect(result).toEqual({ exitCode: 1, stdout: "out", stderr: "err" });
    expect(fake.callsOf("run").map(({ command, cwd }) => ({ command, cwd }))).toEqual([
      { command: "false", cwd: "/tmp" },
    ]);
  });

  it("wakes once for concurrent first operations", async () => {
    const { sdk, fake } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);

    await Promise.all([handle.run("echo a"), handle.run("echo b"), handle.run("echo c")]);

    expect(fake.callsOf("create")).toHaveLength(1);
    expect(new Set(fake.callsOf("run").map((call) => call.sandboxId)).size).toBe(1);
  });
});

describe("the sleep check", () => {
  it("pauses an idle Computer that nothing holds, and marks it asleep", async () => {
    const { sdk, fake, clock } = sdkWith();
    const user = await insertUser();
    await sdk.plugin("computer").forUser(user.id).run("true");
    const [created] = fake.callsOf("create");

    clock.now = after(clock.now, 5 * minuteMs + 1);
    await runDueJobs(sdk, clock.now);

    // Created with the backstop: it pauses itself an hour on, should no check run.
    expect(created?.timeoutMs).toBe(60 * minuteMs);
    expect(fake.callsOf("pause")).toEqual([{ type: "pause", sandboxId: created?.sandboxId }]);
    expect((await computerRow(user.id))?.state).toBe("asleep");
    expect(await queuedChecks()).toEqual([]);
  });

  it("keeps a Computer that isn't idle awake, extends its timeout and checks again when it would be", async () => {
    const { sdk, fake, clock } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.run("true");
    const lastActive = after(clock.now, 2 * minuteMs);
    clock.now = lastActive;
    await handle.run("true");

    clock.now = after(lastActive, 3 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect(fake.callsOf("pause")).toEqual([]);
    expect((await computerRow(user.id))?.state).toBe("awake");
    expect(fake.callsOf("timeout").map((call) => call.timeoutMs)).toEqual([60 * minuteMs]);
    expect(await queuedChecks()).toEqual([after(lastActive, 5 * minuteMs)]);
  });

  it("checks again in a minute when the Computer would already be idle", async () => {
    const { sdk, clock } = sdkWith();
    sdk.plugin("computer").addBusyCheck(async () => true);
    const user = await insertUser();
    await sdk.plugin("computer").forUser(user.id).run("true");

    clock.now = after(clock.now, 5 * minuteMs);
    await runDueJobs(sdk, clock.now);

    // Exactly 5 minutes isn't idle yet, and its follow-up is at least a minute away.
    expect(await queuedChecks()).toEqual([after(clock.now, minuteMs)]);
  });

  it("keeps an idle Computer awake while a busy check holds it, and checks again in a minute", async () => {
    const { sdk, fake, clock } = sdkWith();
    const user = await insertUser();
    const seen: { userId: string; lastActiveAt: Date }[] = [];
    let busy = true;
    sdk.plugin("computer").addBusyCheck(async () => false);
    sdk.plugin("computer").addBusyCheck(async (userId, lastActiveAt) => {
      seen.push({ userId, lastActiveAt });
      return busy;
    });
    const lastActive = clock.now;
    await sdk.plugin("computer").forUser(user.id).run("true");

    clock.now = after(lastActive, 10 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect(seen).toEqual([{ userId: user.id, lastActiveAt: lastActive }]);
    expect(fake.callsOf("pause")).toEqual([]);
    expect(fake.callsOf("timeout")).toHaveLength(1);
    expect(await queuedChecks()).toEqual([after(clock.now, minuteMs)]);

    busy = false;
    clock.now = after(clock.now, minuteMs);
    await runDueJobs(sdk, clock.now);

    expect((await computerRow(user.id))?.state).toBe("asleep");
    expect(await queuedChecks()).toEqual([]);
  });

  it("arms exactly one check on each wake from asleep, and a stray duplicate is harmless", async () => {
    const { sdk, fake, clock } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await Promise.all([handle.run("echo a"), handle.run("echo b")]);
    expect(await queuedChecks()).toEqual([after(clock.now, 5 * minuteMs)]);

    clock.now = after(clock.now, 6 * minuteMs);
    await runDueJobs(sdk, clock.now);
    expect((await computerRow(user.id))?.state).toBe("asleep");

    await Promise.all([handle.run("echo c"), handle.run("echo d")]);
    expect(fake.callsOf("resume")).toHaveLength(1);
    expect(await queuedChecks()).toEqual([after(clock.now, 5 * minuteMs)]);

    // A stray duplicate takes the same lock and reaches the same decision: one sleep, no chain.
    await sdk
      .plugin("runner")
      .enqueue("computer.sleep", { userId: user.id }, { runAfter: after(clock.now, 5 * minuteMs) });
    clock.now = after(clock.now, 6 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect(fake.callsOf("pause")).toHaveLength(2);
    expect((await computerRow(user.id))?.state).toBe("asleep");
    expect(await queuedChecks()).toEqual([]);
  });

  it("has an operation that arrives during a sleep wait for it, then resume the Computer", async () => {
    let pauseStarted!: () => void;
    const pausing = new Promise<void>((resolve) => (pauseStarted = resolve));
    let releasePause!: () => void;
    const held = new Promise<void>((resolve) => (releasePause = resolve));
    const { sdk, fake, clock } = sdkWith({
      onPause: async () => {
        pauseStarted();
        await held;
      },
    });
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.run("echo before");

    clock.now = after(clock.now, 6 * minuteMs);
    const sleeping = runDueJobs(sdk, clock.now);
    await pausing;
    let ran = false;
    const operation = handle.run("echo during").then((result) => {
      ran = true;
      return result;
    });
    await waitForLockWait();
    expect(ran).toBe(false);

    releasePause();
    await sleeping;
    await operation;

    // The sleep's sync lists the files, then archives them, before the pause.
    expect(fake.calls.map((call) => call.type)).toEqual([
      "create",
      "run",
      "run",
      "run",
      "pause",
      "resume",
      "run",
    ]);
    expect((await computerRow(user.id))?.state).toBe("awake");
    expect(await queuedChecks()).toEqual([after(clock.now, 5 * minuteMs)]);
  });

  it("leaves the Computer awake when its pause keeps failing, retries, then arms a fresh check", async () => {
    let failing = true;
    const { sdk, fake, clock } = sdkWith({
      onPause: () => {
        if (failing) throw new Error("pause failed");
      },
    });
    const user = await insertUser();
    await sdk.plugin("computer").forUser(user.id).run("true");

    clock.now = after(clock.now, 6 * minuteMs);
    // Due by then: the retries' backoff counts from the real time, which the clock started at.
    await runDueJobs(sdk, clock.now);

    const [failed] = await getTestDb()
      .select({ status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts })
      .from(job)
      .where(and(eq(job.name, "computer.sleep"), eq(job.status, "failed")));
    expect(failed).toEqual({ status: "failed", attempts: 3, maxAttempts: 3 });
    expect(fake.callsOf("pause")).toEqual([]);
    expect((await computerRow(user.id))?.state).toBe("awake");
    expect(await queuedChecks()).toEqual([after(clock.now, 5 * minuteMs)]);

    failing = false;
    clock.now = after(clock.now, 5 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect((await computerRow(user.id))?.state).toBe("asleep");
  });
});

describe("bot's busy check", () => {
  /** A user's Computer, last active at the clock's start, and a Bot of theirs with no Turn yet. */
  async function idleWithBot() {
    const setup = sdkWith({ withBot: true });
    const user = await insertUser();
    const lastActive = setup.clock.now;
    await setup.sdk.plugin("computer").forUser(user.id).run("true");
    const created = await createBot(getTestDb(), user.id, { name: "Ada", model: "openai:gpt-5.6" });
    const insertTurn = (status: "running" | "complete", startedAt: Date) =>
      getTestDb().insert(botTurn).values({ id: uuidv7(), botId: created.id, status, startedAt });
    return { ...setup, user, lastActive, insertTurn };
  }

  it("keeps the Computer awake while a Turn that started before its last activity runs", async () => {
    const { sdk, fake, clock, user, lastActive, insertTurn } = await idleWithBot();
    await insertTurn("running", after(lastActive, -1_000));

    clock.now = after(lastActive, 10 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect(fake.callsOf("pause")).toEqual([]);
    expect((await computerRow(user.id))?.state).toBe("awake");
    expect(await queuedChecks()).toEqual([after(clock.now, minuteMs)]);
  });

  it("doesn't hold the Computer for a Turn that started after its last activity", async () => {
    const { sdk, clock, user, lastActive, insertTurn } = await idleWithBot();
    await insertTurn("running", after(lastActive, 1_000));

    clock.now = after(lastActive, 10 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect((await computerRow(user.id))?.state).toBe("asleep");
  });

  it("doesn't hold the Computer for a Turn that ended, or another user's running Turn", async () => {
    const { sdk, clock, user, lastActive, insertTurn } = await idleWithBot();
    await insertTurn("complete", after(lastActive, -1_000));
    const other = await insertUser();
    const otherBot = await createBot(getTestDb(), other.id, {
      name: "Bo",
      model: "openai:gpt-5.6",
    });
    await getTestDb()
      .insert(botTurn)
      .values({
        id: uuidv7(),
        botId: otherBot.id,
        status: "running",
        startedAt: after(lastActive, -1_000),
      });

    clock.now = after(lastActive, 10 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect((await computerRow(user.id))?.state).toBe("asleep");
  });
});

/** Moves the clock past the idle time and runs the due sleep check. */
async function sleepNow({ sdk, clock }: { sdk: TestDeps; clock: { now: Date } }) {
  clock.now = after(clock.now, 6 * minuteMs);
  await runDueJobs(sdk, clock.now);
}

const text = (bytes: Uint8Array | null | undefined) => bytes && new TextDecoder().decode(bytes);

describe("syncing the files at sleep", () => {
  it("stores an archive after a file change and records it, and uploads nothing when nothing changed", async () => {
    const setup = sdkWith();
    const { sdk, fake, clock, blobs } = setup;
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.writeFile("/home/user/bots/b1/note.txt", "hello");

    await sleepNow(setup);

    const synced = await computerRow(user.id);
    const archive = await blobs.stored(`computer/${user.id}`);
    expect(synced?.state).toBe("asleep");
    expect(blobs.puts).toEqual([`computer/${user.id}`]);
    expect(synced?.syncedAt).toEqual(clock.now);
    expect(synced?.syncFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(synced?.syncedBytes).toBe(archive?.length);

    await handle.list("/home/user");
    await sleepNow(setup);

    expect(fake.callsOf("pause")).toHaveLength(2);
    expect(blobs.puts).toHaveLength(1);
    expect(await computerRow(user.id)).toMatchObject({
      state: "asleep",
      syncedAt: synced?.syncedAt,
      syncFingerprint: synced?.syncFingerprint,
      syncedBytes: synced?.syncedBytes,
    });

    await handle.writeFile("/home/user/shared/hand.txt", "for Bo");
    await sleepNow(setup);

    expect(blobs.puts).toHaveLength(2);
    expect((await computerRow(user.id))?.syncFingerprint).not.toBe(synced?.syncFingerprint);
  });

  it("leaves .outputs/ out of the archive", async () => {
    const setup = sdkWith();
    const { sdk, fake } = setup;
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.writeFile("/home/user/bots/b1/note.txt", "keep");
    await handle.writeFile("/home/user/bots/b1/.outputs/call-1.txt", "spilled");
    await sleepNow(setup);
    const [first] = fake.callsOf("create");
    fake.lose(first!.sandboxId);

    await handle.list("/home/user");

    expect([...fake.files.keys()]).toContain("/home/user/bots/b1/note.txt");
    expect([...fake.files.keys()].some((path) => path.includes(".outputs"))).toBe(false);
  });

  it("still pauses when the archive is over the cap, logging its size, and keeps the last archive", async () => {
    const setup = sdkWith();
    const { sdk, fake, blobs, logged } = setup;
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.writeFile("/home/user/bots/b1/note.txt", "small");
    await sleepNow(setup);
    const synced = await computerRow(user.id);
    const archive = await blobs.stored(`computer/${user.id}`);

    await handle.list("/home/user");
    fake.files.set("/home/user/shared/big.bin", new Uint8Array(syncCapBytes + 1));
    await sleepNow(setup);

    expect(fake.callsOf("pause")).toHaveLength(2);
    expect(await computerRow(user.id)).toEqual({ ...synced, lastActiveAt: expect.any(Date) });
    expect(await blobs.stored(`computer/${user.id}`)).toEqual(archive);
    expect(blobs.puts).toHaveLength(1);
    expect(String(logged.at(-1)?.[0])).toMatch(/is \d+ bytes, over the 104857600-byte cap/);
  });

  it("still pauses when the blob store fails, logging the cause, and keeps the columns", async () => {
    const setup = sdkWith();
    const { sdk, fake, blobs, logged } = setup;
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.writeFile("/home/user/bots/b1/note.txt", "one");
    await sleepNow(setup);
    const synced = await computerRow(user.id);

    await handle.writeFile("/home/user/bots/b1/note.txt", "two");
    blobs.failing.add("put");
    await sleepNow(setup);

    expect(fake.callsOf("pause")).toHaveLength(2);
    expect(await computerRow(user.id)).toEqual({ ...synced, lastActiveAt: expect.any(Date) });
    expect(text(await blobs.stored(`computer/${user.id}`))).toContain("one");
    const [message, cause] = logged.at(-1) ?? [];
    expect(String(message)).toContain("Syncing the files");
    expect(String(cause)).toContain("told to fail put");
  });
});

describe("a wake that rebuilds", () => {
  /** A user whose Computer has a synced note and is asleep. */
  async function asleepWithNote() {
    const setup = sdkWith();
    const user = await insertUser();
    const handle = setup.sdk.plugin("computer").forUser(user.id);
    await handle.writeFile("/home/user/bots/b1/note.txt", "remember me");
    await sleepNow(setup);
    const [first] = setup.fake.callsOf("create");
    return {
      ...setup,
      user,
      handle,
      firstId: first!.sandboxId,
      synced: await computerRow(user.id),
    };
  }

  it("is a plain create on the first wake, with no restore and no rebuild to tell", async () => {
    const { sdk, fake, blobs } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);

    await handle.list("/home/user");

    expect(fake.calls.map((call) => call.type)).toEqual(["create"]);
    expect(handle.takeRebuild()).toBeNull();
    expect(blobs.puts).toEqual([]);
  });

  it("rebuilds a lost sandbox from the template, restores the files, and tells it once", async () => {
    const { fake, user, handle, firstId, synced } = await asleepWithNote();
    fake.lose(firstId);

    const note = await handle.readFile("/home/user/bots/b1/note.txt");

    const [, second] = fake.callsOf("create");
    expect(text(note)).toBe("remember me");
    expect(fake.callsOf("resume")).toEqual([]);
    expect(await computerRow(user.id)).toMatchObject({
      state: "awake",
      sandboxId: second?.sandboxId,
      template: "fake-computer-v1",
    });
    expect(handle.takeRebuild()).toEqual({ restoredAsOf: synced?.syncedAt });
    expect(handle.takeRebuild()).toBeNull();
    await handle.list("/home/user");
    expect(handle.takeRebuild()).toBeNull();
  });

  it("rebuilds on a changed template, restores the files, and kills the old sandbox", async () => {
    const { fake, user, handle, firstId, synced } = await asleepWithNote();
    fake.provider.template = "fake-computer-v2";

    await handle.list("/home/user/bots/b1");

    const [, second] = fake.callsOf("create");
    expect(fake.callsOf("resume")).toEqual([]);
    expect(fake.callsOf("kill-sandbox")).toEqual([{ type: "kill-sandbox", sandboxId: firstId }]);
    expect(text(fake.files.get("/home/user/bots/b1/note.txt"))).toBe("remember me");
    expect(await computerRow(user.id)).toMatchObject({
      state: "awake",
      sandboxId: second?.sandboxId,
      template: "fake-computer-v2",
    });
    expect(handle.takeRebuild()).toEqual({ restoredAsOf: synced?.syncedAt });
  });

  it("fails the wake when the restore fails, kills the new sandbox, leaves the row, and the next call retries", async () => {
    const { fake, user, handle, firstId, blobs } = await asleepWithNote();
    fake.lose(firstId);
    blobs.failing.add("get");

    await expect(handle.list("/home/user")).rejects.toBeInstanceOf(ComputerUnavailableError);

    const [, failed] = fake.callsOf("create");
    expect(fake.callsOf("kill-sandbox")).toEqual([
      { type: "kill-sandbox", sandboxId: failed?.sandboxId },
    ]);
    expect(await computerRow(user.id)).toMatchObject({
      state: "asleep",
      sandboxId: firstId,
      template: "fake-computer-v1",
    });
    expect(handle.takeRebuild()).toBeNull();

    blobs.failing.delete("get");
    const note = await handle.readFile("/home/user/bots/b1/note.txt");

    const [, , retried] = fake.callsOf("create");
    expect(text(note)).toBe("remember me");
    expect((await computerRow(user.id))?.sandboxId).toBe(retried?.sandboxId);
  });

  it("starts empty when a lost Computer was never synced, and says so", async () => {
    const { sdk, fake } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.list("/home/user");
    await getTestDb()
      .update(computerTable)
      .set({ state: "asleep" })
      .where(eq(computerTable.userId, user.id));
    fake.lose(fake.callsOf("create")[0]!.sandboxId);

    await handle.list("/home/user");

    expect(fake.callsOf("create")).toHaveLength(2);
    expect(handle.takeRebuild()).toEqual({ restoredAsOf: null });
  });
});

describe("a sleep check left queued", () => {
  it("ends on an instance with computer turned off, with no follow-up", async () => {
    const sdk = createTestSdk();
    const user = await insertUser();
    await sdk.plugin("runner").enqueue("computer.sleep", { userId: user.id });

    await runDueJobs(sdk, new Date());

    expect(await queuedChecks()).toEqual([]);
    const [check] = await getTestDb().select({ status: job.status }).from(job);
    expect(check?.status).toBe("succeeded");
  });
});

/** Waits until a session of this test's database is blocked on a lock. */
async function waitForLockWait() {
  for (let tries = 0; tries < 200; tries += 1) {
    const { rows } = await getTestDb().execute<{ waiting: number }>(sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`);
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("No session waited on a lock");
}

describe("hasPlugin", () => {
  it("says whether computer is enabled", () => {
    expect(sdkWith().sdk.hasPlugin("computer")).toBe(true);
    expect(createTestSdk().hasPlugin("computer")).toBe(false);
  });
});
