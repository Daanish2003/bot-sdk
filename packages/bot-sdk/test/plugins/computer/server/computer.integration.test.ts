import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { postgresBlobStore } from "../../../../core/server/blob/postgres";
import type { BlobStore } from "../../../../core/server/blob/store";
import {
  bot as botTable,
  botHelper,
  botTurn,
  computer as computerTable,
  job,
} from "../../../../core/server/db/schema";
import { deleteUserData } from "../../../../core/server/user-data";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { createBot } from "../../../../plugins/bot/server/store";
import {
  computer,
  ComputerOperationError,
  ComputerUnavailableError,
  syncCapBytes,
} from "../../../../plugins/computer/server/plugin";
import { SandboxGoneError, type CommandResult } from "../../../../plugins/computer/server/provider";
import type { JobRunner } from "../../../../plugins/runner/server/jobs/runner";
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
  const failing = new Set<"put" | "get" | "delete">();
  const failIfTold = (call: "put" | "get" | "delete") => {
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
    delete: async (keys) => {
      failIfTold("delete");
      await inner.delete(keys);
    },
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
      rebuiltAt: null,
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

    // The sleep's sync lists the files, archives them and removes the archive, before the pause.
    expect(fake.calls.map((call) => call.type)).toEqual([
      "create",
      "run",
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
    const created = await createBot(
      getTestDb(),
      user.id,
      { name: "Ada", model: "openai:gpt-5.6" },
      new Date(),
    );
    await setup.sdk.plugin("computer").forUser(user.id).run("true");
    const insertTurn = (status: "running" | "complete", startedAt: Date) =>
      getTestDb().insert(botTurn).values({ id: uuidv7(), botId: created.id, status, startedAt });
    /** A General Helper of the Bot, started by a Turn that has ended. */
    const insertHelper = async (status: "running" | "waiting" | "complete", startedAt: Date) => {
      const turnId = uuidv7();
      await getTestDb()
        .insert(botTurn)
        .values({ id: turnId, botId: created.id, status: "complete", startedAt });
      await getTestDb().insert(botHelper).values({
        id: uuidv7(),
        botId: created.id,
        type: "general",
        task: "Count the files.",
        status,
        startedByTurnId: turnId,
        startedAt,
      });
    };
    return { ...setup, user, lastActive, insertTurn, insertHelper };
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

  it("holds the Computer for a Turn stamped a few seconds after its last activity, as clock skew allows", async () => {
    const { sdk, fake, clock, user, lastActive, insertTurn } = await idleWithBot();
    await insertTurn("running", after(lastActive, 5_000));

    clock.now = after(lastActive, 10 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect(fake.callsOf("pause")).toEqual([]);
    expect((await computerRow(user.id))?.state).toBe("awake");
  });

  it("doesn't hold the Computer for a Turn that started well after its last activity", async () => {
    const { sdk, clock, user, lastActive, insertTurn } = await idleWithBot();
    await insertTurn("running", after(lastActive, minuteMs));

    clock.now = after(lastActive, 10 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect((await computerRow(user.id))?.state).toBe("asleep");
  });

  it("keeps the Computer awake while a Helper runs, however long ago it started", async () => {
    const { sdk, fake, clock, user, lastActive, insertHelper } = await idleWithBot();
    await insertHelper("running", after(lastActive, minuteMs));

    clock.now = after(lastActive, 10 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect(fake.callsOf("pause")).toEqual([]);
    expect((await computerRow(user.id))?.state).toBe("awake");
  });

  it("doesn't hold the Computer for a Helper waiting for the user, or one that ended", async () => {
    const { sdk, clock, user, lastActive, insertHelper } = await idleWithBot();
    await insertHelper("waiting", after(lastActive, -1_000));
    await insertHelper("complete", after(lastActive, -1_000));

    clock.now = after(lastActive, 10 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect((await computerRow(user.id))?.state).toBe("asleep");
  });

  it("doesn't hold the Computer for a Turn that ended, or another user's running Turn", async () => {
    const { sdk, clock, user, lastActive, insertTurn } = await idleWithBot();
    await insertTurn("complete", after(lastActive, -1_000));
    const other = await insertUser();
    const otherBot = await createBot(
      getTestDb(),
      other.id,
      { name: "Bo", model: "openai:gpt-5.6" },
      new Date(),
    );
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
    // No snapshot keeps the archive.
    expect([...fake.files.keys()]).toEqual(["/home/user/bots/b1/note.txt"]);

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
    expect(handle.rebuild()).toBeNull();
    expect(blobs.puts).toEqual([]);
  });

  it("rebuilds a lost sandbox from the template, restores the files, and records the rebuild", async () => {
    const { sdk, fake, clock, user, handle, firstId, synced } = await asleepWithNote();
    fake.lose(firstId);

    const note = await handle.readFile("/home/user/bots/b1/note.txt");

    const [, second] = fake.callsOf("create");
    expect(text(note)).toBe("remember me");
    expect([...fake.files.keys()]).toEqual(["/home/user/bots/b1/note.txt"]);
    expect(fake.callsOf("resume")).toEqual([]);
    expect(await computerRow(user.id)).toMatchObject({
      state: "awake",
      sandboxId: second?.sandboxId,
      template: "fake-computer-v1",
      rebuiltAt: clock.now,
    });
    const rebuilt = { rebuiltAt: clock.now, restoredAsOf: synced?.syncedAt };
    expect(handle.rebuild()).toEqual(rebuilt);
    // Every later operation, through any handle of the user, sees the same rebuild.
    const another = sdk.plugin("computer").forUser(user.id);
    expect(another.rebuild()).toBeNull();
    clock.now = after(clock.now, minuteMs);
    await another.list("/home/user");
    expect(another.rebuild()).toEqual(rebuilt);
    expect(fake.callsOf("create")).toHaveLength(2);
  });

  it("no longer knows what a rebuild restored once a later sync replaced its archive", async () => {
    const setup = await asleepWithNote();
    const { fake, clock, handle, firstId } = setup;
    fake.lose(firstId);
    await handle.list("/home/user");
    const rebuiltAt = clock.now;
    await handle.writeFile("/home/user/bots/b1/later.txt", "new");
    await sleepNow(setup);

    await handle.list("/home/user");

    expect(handle.rebuild()).toEqual({ rebuiltAt, restoredAsOf: undefined });
  });

  it("starts empty when the archive is missing, and forgets the sync it can't restore", async () => {
    const { fake, clock, user, handle, firstId, blobs } = await asleepWithNote();
    fake.lose(firstId);
    await blobs.store.delete([`computer/${user.id}`]);

    await handle.list("/home/user");

    expect(fake.files.size).toBe(0);
    expect(handle.rebuild()).toEqual({ rebuiltAt: clock.now, restoredAsOf: null });
    expect(await computerRow(user.id)).toMatchObject({
      syncedAt: null,
      syncFingerprint: null,
      syncedBytes: null,
    });
  });

  it("rebuilds on a changed template, restores the files, and kills the old sandbox", async () => {
    const { fake, clock, user, handle, firstId, synced } = await asleepWithNote();
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
    expect(handle.rebuild()).toEqual({ rebuiltAt: clock.now, restoredAsOf: synced?.syncedAt });
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
      rebuiltAt: null,
    });
    expect(handle.rebuild()).toBeNull();

    blobs.failing.delete("get");
    const note = await handle.readFile("/home/user/bots/b1/note.txt");

    const [, , retried] = fake.callsOf("create");
    expect(text(note)).toBe("remember me");
    expect((await computerRow(user.id))?.sandboxId).toBe(retried?.sandboxId);
  });

  it("starts empty when a lost Computer was never synced, and says so", async () => {
    const { sdk, fake, clock } = sdkWith();
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
    expect(handle.rebuild()).toEqual({ rebuiltAt: clock.now, restoredAsOf: null });
  });
});

describe("an awake Computer whose sandbox is gone", () => {
  /** A user whose Computer has a synced note, was woken again, and then lost its sandbox. */
  async function awakeAndLost() {
    const setup = sdkWith();
    const user = await insertUser();
    const handle = setup.sdk.plugin("computer").forUser(user.id);
    await handle.writeFile("/home/user/bots/b1/note.txt", "remember me");
    await sleepNow(setup);
    const synced = await computerRow(user.id);
    await handle.list("/home/user");
    expect((await computerRow(user.id))?.state).toBe("awake");
    const [first] = setup.fake.callsOf("create");
    setup.fake.lose(first!.sandboxId);
    return { ...setup, user, handle, synced };
  }

  it("is rebuilt by its next operation, with the files restored and the rebuild told", async () => {
    const { fake, clock, user, handle, synced } = await awakeAndLost();

    const note = await handle.readFile("/home/user/bots/b1/note.txt");

    const [, second] = fake.callsOf("create");
    expect(text(note)).toBe("remember me");
    expect(await computerRow(user.id)).toMatchObject({
      state: "awake",
      sandboxId: second?.sandboxId,
    });
    expect(handle.rebuild()).toEqual({ rebuiltAt: clock.now, restoredAsOf: synced?.syncedAt });
    // The lost awake period's check is cancelled: one chain, armed by the rebuild's wake.
    expect(await queuedChecks()).toHaveLength(1);
  });

  it("is unavailable when the rebuilt sandbox is gone too", async () => {
    const { fake, handle } = await awakeAndLost();
    fake.provider.readFile = async (sandboxId) => {
      throw new SandboxGoneError(sandboxId);
    };

    await expect(handle.readFile("/home/user/bots/b1/note.txt")).rejects.toBeInstanceOf(
      ComputerUnavailableError,
    );
  });

  it("is marked asleep by an idle sleep check, which ends its chain, and the next operation rebuilds it", async () => {
    const setup = await awakeAndLost();
    const { fake, user, handle, logged } = setup;

    await sleepNow(setup);

    // A gone sandbox is no sync failure.
    expect(logged).toEqual([]);
    expect(await getTestDb().select().from(job).where(eq(job.status, "failed"))).toEqual([]);
    expect((await computerRow(user.id))?.state).toBe("asleep");
    expect(await queuedChecks()).toEqual([]);
    expect(text(await handle.readFile("/home/user/bots/b1/note.txt"))).toBe("remember me");
    expect(fake.callsOf("create")).toHaveLength(2);
  });

  it("is marked asleep by a sleep check that would keep it awake, which ends its chain", async () => {
    const { sdk, user, clock } = await awakeAndLost();
    sdk.plugin("computer").addBusyCheck(async () => true);

    clock.now = after(clock.now, 6 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect(await getTestDb().select().from(job).where(eq(job.status, "failed"))).toEqual([]);
    expect((await computerRow(user.id))?.state).toBe("asleep");
    expect(await queuedChecks()).toEqual([]);
  });
});

describe("a wake whose transaction fails after its create", () => {
  it("kills the new sandbox, and the next call creates another", async () => {
    const { sdk, fake, logged } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    const runner = sdk.plugin("runner");
    const enqueueIn = runner.enqueueIn;
    runner.enqueueIn = async () => {
      throw new Error("the database went away");
    };

    await expect(handle.list("/home/user")).rejects.toThrow("the database went away");

    const [created] = fake.callsOf("create");
    expect(fake.callsOf("kill-sandbox")).toEqual([
      { type: "kill-sandbox", sandboxId: created?.sandboxId },
    ]);
    expect(await computerRow(user.id)).toMatchObject({ state: "asleep", sandboxId: null });
    expect(logged).toEqual([]);

    runner.enqueueIn = enqueueIn;
    await handle.list("/home/user");

    const [, retried] = fake.callsOf("create");
    expect(await computerRow(user.id)).toMatchObject({
      state: "awake",
      sandboxId: retried?.sandboxId,
    });
  });
});

describe("the computer plugin on a runner that is not in-process", () => {
  it("fails at startup, because a wake queues its sleep check in its transaction", () => {
    const elsewhere: JobRunner = {
      enqueue: async () => "job",
      cancel: async () => {},
      status: async () => undefined,
      schedule: async () => {},
      start: async () => {},
      stop: async () => {},
    };
    const { provider } = fakeComputerProvider();

    expect(() => createTestSdk({ plugins: [computer({ provider })], jobs: elsewhere })).toThrow(
      /in-process/,
    );
  });
});

describe("an operation the provider fails", () => {
  it("throws ComputerOperationError with the cause, and still records activity", async () => {
    const { sdk, fake, clock } = sdkWith({
      onCommand: () => {
        throw new Error("cwd: permission denied");
      },
    });
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.writeFile("/home/user/bots/b1/note.txt", "hi");

    const failed = handle.run("true");
    await expect(failed).rejects.toBeInstanceOf(ComputerOperationError);
    await expect(failed).rejects.toThrow("cwd: permission denied");
    await expect(handle.readFile("/home/user/bots")).rejects.toBeInstanceOf(ComputerOperationError);
    await expect(handle.list("/home/user/bots/b1/note.txt")).rejects.toBeInstanceOf(
      ComputerOperationError,
    );
    expect(fake.callsOf("create")).toHaveLength(1);
    expect((await computerRow(user.id))?.lastActiveAt).toEqual(clock.now);
  });

  it("rethrows a stop as it is, not as an operation error", async () => {
    const { sdk } = sdkWith({ onCommand: () => new Promise(() => {}) });
    const user = await insertUser();
    const stop = new AbortController();
    const reason = new Error("stopped");

    const running = sdk
      .plugin("computer")
      .forUser(user.id)
      .run("sleep 100", { signal: stop.signal });
    setTimeout(() => stop.abort(reason), 50);

    await expect(running).rejects.toBe(reason);
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

describe("deleting", () => {
  /** A user with a synced Computer, asleep, with a note of a Bot in its directory. */
  async function syncedComputer() {
    const setup = sdkWith({ withBot: true });
    const user = await insertUser();
    await createBot(getTestDb(), user.id, { name: "Ada", model: "openai:gpt-5.6" }, new Date());
    const handle = setup.sdk.plugin("computer").forUser(user.id);
    await handle.writeFile("/home/user/bots/b1/note.txt", "remember me");
    await sleepNow(setup);
    return { ...setup, user, handle };
  }

  it("deletes the row, kills the sandbox and deletes the archive when the user is deleted", async () => {
    const { sdk, fake, blobs, user } = await syncedComputer();
    const sandboxId = (await computerRow(user.id))?.sandboxId;
    expect(await blobs.stored(`computer/${user.id}`)).not.toBeNull();

    await deleteUserData(sdk, user.id);

    expect(await computerRow(user.id)).toBeUndefined();
    expect(fake.callsOf("kill-sandbox")).toEqual([{ type: "kill-sandbox", sandboxId }]);
    expect(await blobs.stored(`computer/${user.id}`)).toBeNull();
  });

  it("deletes the user even when the kill and the blob delete fail, logging both", async () => {
    const { sdk, fake, blobs, user, logged } = await syncedComputer();
    fake.provider.kill = async () => {
      throw new Error("kill failed");
    };
    blobs.failing.add("delete");

    await expect(deleteUserData(sdk, user.id)).resolves.toBeUndefined();

    expect(await computerRow(user.id)).toBeUndefined();
    const messages = logged.map(([message]) => String(message));
    expect(messages.some((message) => message.includes("Killing sandbox"))).toBe(true);
    expect(messages.some((message) => message.includes("Deleting blobs"))).toBe(true);
  });

  it("does nothing for a user who never used their Computer", async () => {
    const { sdk, fake, blobs } = sdkWith();
    const user = await insertUser();

    await deleteUserData(sdk, user.id);

    expect(fake.callsOf("kill-sandbox")).toEqual([]);
    expect(blobs.puts).toEqual([]);
  });

  it("keeps a Bot's files on the Computer and in the next archive when the Bot is deleted", async () => {
    const setup = await syncedComputer();
    const { handle, blobs, user } = setup;
    const created = await createBot(
      getTestDb(),
      user.id,
      { name: "Ada", model: "openai:gpt-5.6" },
      new Date(),
    );
    await handle.writeFile(`/home/user/bots/${created.id}/work.txt`, "mine");

    await getTestDb().delete(botTable).where(eq(botTable.id, created.id));
    await sleepNow(setup);

    expect(await handle.readFile(`/home/user/bots/${created.id}/work.txt`)).not.toBeNull();
    const archive = text(await blobs.stored(`computer/${user.id}`));
    expect(archive).toContain(`bots/${created.id}/work.txt`);
    expect(archive).toContain("bots/b1/note.txt");
    expect(await computerRow(user.id)).toBeDefined();
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

describe("an operation for a user with nothing that uses a Computer", () => {
  it("creates no row, no sandbox and no blob once the user is deleted", async () => {
    const setup = sdkWith({ withBot: true });
    const { sdk, fake, blobs } = setup;
    const user = await insertUser();
    await createBot(getTestDb(), user.id, { name: "Ada", model: "openai:gpt-5.6" }, new Date());
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.run("true");
    await deleteUserData(sdk, user.id);

    await expect(handle.run("true")).rejects.toBeInstanceOf(ComputerUnavailableError);

    expect(await computerRow(user.id)).toBeUndefined();
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(await queuedChecks()).toEqual([]);
    await sleepNow(setup);
    expect(await blobs.stored(`computer/${user.id}`)).toBeNull();
  });

  it("creates nothing when it waits on a user delete that commits", async () => {
    const { sdk, fake } = sdkWith({ withBot: true });
    const user = await insertUser();
    await createBot(getTestDb(), user.id, { name: "Ada", model: "openai:gpt-5.6" }, new Date());
    let commit!: () => void;
    const committing = new Promise<void>((resolve) => (commit = resolve));
    let deleted!: () => void;
    const deleting = new Promise<void>((resolve) => (deleted = resolve));
    // The user's delete has removed their Bots and not yet committed.
    const deletion = getTestDb().transaction(async (tx) => {
      await tx.delete(botTable).where(eq(botTable.userId, user.id));
      deleted();
      await committing;
    });
    await deleting;

    const operation = sdk.plugin("computer").forUser(user.id).run("true");
    const settled = operation.catch((caught: unknown) => caught);
    await waitForLockWait();
    commit();
    await deletion;

    expect(await settled).toBeInstanceOf(ComputerUnavailableError);
    expect(await computerRow(user.id)).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it("is refused for a user with no Bot when bot is on, and allowed when no plugin checks", async () => {
    const withBot = sdkWith({ withBot: true });
    const alone = sdkWith();
    const user = await insertUser();

    await expect(
      withBot.sdk.plugin("computer").forUser(user.id).run("true"),
    ).rejects.toBeInstanceOf(ComputerUnavailableError);
    expect(await computerRow(user.id)).toBeUndefined();

    await alone.sdk.plugin("computer").forUser(user.id).run("true");
    expect((await computerRow(user.id))?.state).toBe("awake");
  });
});

describe("a long operation", () => {
  it("keeps the Computer awake while it runs, whoever called it, and stops recording once it ends", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => (finish = resolve));
    const { sdk, fake, clock } = sdkWith({
      onCommand: async () => {
        started();
        await finishing;
        return ok;
      },
    });
    const user = await insertUser();
    const start = clock.now;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const operation = sdk.plugin("computer").forUser(user.id).run("make all");
      await running;

      // Four minutes in, the operation's heartbeat records activity.
      clock.now = after(start, 4 * minuteMs);
      await vi.advanceTimersByTimeAsync(minuteMs);
      await vi.waitFor(async () =>
        expect((await computerRow(user.id))?.lastActiveAt).toEqual(clock.now),
      );
      // Seven minutes in, the sleep check finds it active three minutes ago.
      clock.now = after(start, 7 * minuteMs);
      await runDueJobs(sdk, clock.now);

      expect(fake.callsOf("pause")).toEqual([]);
      expect((await computerRow(user.id))?.state).toBe("awake");

      finish();
      await operation;
      const finished = clock.now;
      clock.now = after(start, 9 * minuteMs);
      await vi.advanceTimersByTimeAsync(5 * minuteMs);
      expect((await computerRow(user.id))?.lastActiveAt).toEqual(finished);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Screens", () => {
  const screenCommands = (fake: ReturnType<typeof sdkWith>["fake"]) =>
    fake
      .callsOf("run")
      .map((call) => call.command)
      .filter((command) => command.startsWith("/usr/local/bin/ai-chat-screen"));

  it("opens a Screen with a fresh token and the profile key, and closes it", async () => {
    const { sdk, fake } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);

    await handle.openScreen(2, "work");
    const firstToken = text(fake.files.get("/tmp/screens/2/token"));
    await handle.openScreen(2, "work");
    await handle.closeScreen(2);

    expect(firstToken).toMatch(/^[0-9a-f]{48}$/);
    expect(text(fake.files.get("/tmp/screens/2/token"))).not.toBe(firstToken);
    expect(screenCommands(fake)).toEqual([
      "/usr/local/bin/ai-chat-screen start 2 work",
      "/usr/local/bin/ai-chat-screen start 2 work",
      "/usr/local/bin/ai-chat-screen stop 2",
    ]);
  });

  it("gives the CDP endpoint and the tokened noVNC link of an open Screen", async () => {
    const { sdk, fake } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.openScreen(3, "work");
    const [created] = fake.callsOf("create");
    const token = text(fake.files.get("/tmp/screens/3/token"));

    const urls = await handle.screenUrls(3);

    const id = created?.sandboxId;
    expect(urls.cdp).toEqual({
      url: `https://9225-${id}.fake.test`,
      headers: { "e2b-traffic-access-token": `traffic-${id}`, "fake-port": "9225" },
    });
    expect(urls.novnc.headers).toEqual({
      "e2b-traffic-access-token": `traffic-${id}`,
      "fake-port": "6083",
    });
    const novnc = new URL(urls.novnc.url);
    expect(novnc.origin).toBe(`https://6083-${id}.fake.test`);
    expect(novnc.pathname).toBe("/vnc.html");
    expect(novnc.searchParams.get("path")).toBe(`websockify?token=${token}`);
    expect(fake.callsOf("endpoint").map((call) => call.port)).toEqual([6083, 9225]);
  });

  it("refuses the links of a Screen that isn't open", async () => {
    const { sdk } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);

    await expect(handle.screenUrls(1)).rejects.toBeInstanceOf(ComputerOperationError);
  });

  it("switches a Screen between view-only and control", async () => {
    const { sdk, fake } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);

    await handle.setScreenControl(1, "control");
    await handle.setScreenControl(1, "view");

    expect(screenCommands(fake)).toEqual([
      "/usr/local/bin/ai-chat-screen control 1",
      "/usr/local/bin/ai-chat-screen view 1",
    ]);
  });

  it("counts a live view's heartbeat as activity, without waking an asleep Computer", async () => {
    const setup = sdkWith();
    const { sdk, fake, clock } = setup;
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.openScreen(1, "work");
    const start = clock.now;

    // Four minutes in, the live view's heartbeat; seven minutes in, the sleep check finds it active.
    clock.now = after(start, 4 * minuteMs);
    await handle.heartbeat();
    clock.now = after(start, 7 * minuteMs);
    await runDueJobs(sdk, clock.now);

    expect(fake.callsOf("pause")).toEqual([]);
    expect(await computerRow(user.id)).toMatchObject({
      state: "awake",
      lastActiveAt: after(start, 4 * minuteMs),
    });

    await sleepNow(setup);
    const calls = fake.calls.length;
    await handle.heartbeat();

    expect(fake.calls).toHaveLength(calls);
    expect((await computerRow(user.id))?.state).toBe("asleep");
  });

  it("fails an open whose start script fails, with its message", async () => {
    const { sdk } = sdkWith({
      onCommand: () => ({ exitCode: 1, stdout: "", stderr: "Xvfb did not start" }),
    });
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);

    await expect(handle.openScreen(1, "work")).rejects.toThrow(/Xvfb did not start/);
  });

  it("rejects a slot outside 1 to 4 and a profile key with other characters, before waking", async () => {
    const { sdk, fake } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);

    await expect(handle.openScreen(5, "work")).rejects.toThrow(RangeError);
    await expect(handle.closeScreen(0)).rejects.toThrow(RangeError);
    await expect(handle.openScreen(1, "a'; rm -rf ~; '")).rejects.toThrow(RangeError);

    expect(fake.calls).toEqual([]);
  });

  it("keeps Chrome profiles out of the synced archive", async () => {
    const setup = sdkWith();
    const { sdk, fake } = setup;
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);
    await handle.writeFile("/home/user/bots/b1/note.txt", "keep");
    await handle.writeFile("/home/user/.chrome-profiles/work/Cookies", "secret");
    await sleepNow(setup);
    const [first] = fake.callsOf("create");
    fake.lose(first!.sandboxId);

    await handle.list("/home/user");

    expect([...fake.files.keys()]).toEqual(["/home/user/bots/b1/note.txt"]);
  });
});

describe("hasPlugin", () => {
  it("says whether computer is enabled", () => {
    expect(sdkWith().sdk.hasPlugin("computer")).toBe(true);
    expect(createTestSdk().hasPlugin("computer")).toBe(false);
  });
});
