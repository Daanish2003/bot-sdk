import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { botTurn, computer as computerTable, job } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { createBot } from "../../../../plugins/bot/server/store";
import { computer } from "../../../../plugins/computer/server/plugin";
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
  const sdk = createTestSdk({
    plugins: [...(withBot ? [bot()] : []), computer({ provider: fake.provider })],
    clock: () => clock.now,
  });
  return { sdk, fake, clock };
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

    expect(fake.calls.map((call) => call.type)).toEqual([
      "create",
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
