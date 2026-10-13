import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createChat } from "../../../../core/server/create-chat";
import { job } from "../../../../core/server/db/schema/job";
import { defineJob, PermanentJobError } from "../../../../core/server/jobs/define";
import { inProcessRunner, type JobClock } from "../../../../core/server/jobs/in-process";
import type { JobRunner } from "../../../../core/server/jobs/runner";
import { createTestDeps } from "../../../support/deps";
import { drainJobs } from "../../../support/jobs";
import { getTestDb, testDatabaseUrl } from "../../../support/test-database";

const start = new Date("2026-10-14T10:00:00Z");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { error: () => {} };
/** The jobs in this file take no SDK dependencies, so their runners get fresh test deps. */
const testDeps = () => createTestDeps();

/** A clock the test moves by hand; `tick()` fires the poll timer. */
function fakeClock() {
  let current = start.getTime();
  const timers = new Set<() => void>();
  const clock: JobClock = {
    now: () => new Date(current),
    setInterval: (callback) => {
      timers.add(callback);
      return callback;
    },
    clearInterval: (handle) => {
      timers.delete(handle as () => void);
    },
  };
  return {
    clock,
    advance: (ms: number) => {
      current += ms;
    },
    tick: () => {
      for (const timer of timers) timer();
    },
  };
}

// Test-only jobs. Each test sets their behaviour through these variables.
const ran: string[] = [];
const started: string[] = [];
const failedLabels: string[] = [];
let failure: unknown;
let gate: Promise<void> | undefined;

defineJob({
  name: "test.record",
  payload: z.object({ label: z.string() }),
  run: async ({ label }) => {
    started.push(label);
    await gate;
    ran.push(label);
  },
});

defineJob({
  name: "test.fail",
  payload: z.object({ label: z.string() }),
  run: async () => {
    if (failure) throw failure;
  },
  onFailed: ({ label }) => {
    failedLabels.push(label);
  },
});

/** Every `chat.job` row, read straight from the test database. */
const jobRows = () => getTestDb().select().from(job);

/** The status of the job with this name, or undefined when there is none. */
async function statusOf(name: string) {
  const [row] = await getTestDb().select().from(job).where(eq(job.name, name));
  return row?.status;
}

beforeEach(() => {
  ran.length = 0;
  started.length = 0;
  failedLabels.length = 0;
  failure = undefined;
  gate = undefined;
});

afterEach(() => {
  failure = undefined;
  gate = undefined;
});

describe("enqueue", () => {
  it("stores a queued job with its payload and the default retry settings", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: fakeClock().clock,
    });

    await runner.enqueue("test.record", { label: "a" });

    const [row] = await jobRows();
    expect(row).toMatchObject({
      name: "test.record",
      payload: { label: "a" },
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      idempotencyKey: null,
      lastError: null,
    });
    expect(row?.runAfter.getTime()).toBe(start.getTime());
  });

  it("makes a second enqueue with an active key a no-op, and reuses the key once the job has ended", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: fakeClock().clock,
    });

    await runner.enqueue("test.record", { label: "a" }, { idempotencyKey: "k1" });
    await runner.enqueue("test.record", { label: "b" }, { idempotencyKey: "k1" });
    expect(await jobRows()).toHaveLength(1);

    await drainJobs();
    await runner.enqueue("test.record", { label: "c" }, { idempotencyKey: "k1" });
    expect(await jobRows()).toHaveLength(2);
  });

  it("honours runAfter", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: fakeClock().clock,
    });
    const later = new Date(start.getTime() + 60_000);

    await runner.enqueue("test.record", { label: "a" }, { runAfter: later });

    const [row] = await jobRows();
    expect(row?.runAfter.getTime()).toBe(later.getTime());
  });

  it("refuses an unknown job name and an invalid payload", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: fakeClock().clock,
    });

    await expect(runner.enqueue("test.missing", {})).rejects.toThrow(/No job named/);
    await expect(runner.enqueue("test.record", {})).rejects.toThrow();
    expect(await jobRows()).toHaveLength(0);
  });
});

describe("the in-process runner", () => {
  it("runs a queued job once it is started", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: fakeClock().clock,
    });
    await runner.enqueue("test.record", { label: "a" });

    await runner.start();

    await expect.poll(() => ran).toEqual(["a"]);
    await expect.poll(() => statusOf("test.record")).toBe("succeeded");
    await runner.stop();
  });

  it("wakes at once when its own enqueue adds a job, without waiting for the poll", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: fakeClock().clock,
    });
    await runner.start();

    await runner.enqueue("test.record", { label: "a" });

    await expect.poll(() => ran).toEqual(["a"]);
    await runner.stop();
  });

  it("polls on its timer for a job another process queued", async () => {
    const timer = fakeClock();
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: timer.clock,
    });
    await runner.start();
    const otherProcess = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: timer.clock,
    });
    await otherProcess.enqueue("test.record", { label: "a" });
    await sleep(20);
    expect(ran).toEqual([]);

    timer.tick();

    await expect.poll(() => ran).toEqual(["a"]);
    await runner.stop();
  });

  it("runs at most two jobs at once by default", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: fakeClock().clock,
    });
    let release!: () => void;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    for (const label of ["a", "b", "c"]) await runner.enqueue("test.record", { label });

    await runner.start();
    await expect.poll(() => started.length).toBe(2);
    await sleep(50);
    expect(started).toHaveLength(2);

    release();
    await expect.poll(() => ran.length).toBe(3);
    await runner.stop();
  });

  it("never runs the same job twice when two runners share one database", async () => {
    const { clock } = fakeClock();
    const db = getTestDb();
    const runners: JobRunner[] = [
      inProcessRunner({ db, logger: silent, deps: testDeps, clock, concurrency: 4 }),
      inProcessRunner({ db, logger: silent, deps: testDeps, clock, concurrency: 4 }),
    ];
    const labels = Array.from({ length: 20 }, (_, index) => `job-${index}`);
    for (const label of labels) await runners[0]!.enqueue("test.record", { label });

    await Promise.all(runners.map((runner) => runner.start()));

    await expect.poll(() => ran.length).toBe(20);
    expect(new Set(ran).size).toBe(20);
    expect((await jobRows()).map((row) => row.attempts)).toEqual(labels.map(() => 1));
    for (const runner of runners) await runner.stop();
  });
});

describe("retries", () => {
  it("retries after about 10 s, then after about 1 min, then fails the job and runs onFailed", async () => {
    const timer = fakeClock();
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: timer.clock,
    });
    failure = new Error("boom");
    await runner.enqueue("test.fail", { label: "a" });
    await runner.start();

    await expect.poll(async () => (await jobRows())[0]?.attempts).toBe(1);
    const [first] = await jobRows();
    expect(first).toMatchObject({ status: "queued", lastError: "boom" });
    expect(first!.runAfter.getTime() - timer.clock.now().getTime()).toBe(10_000);

    timer.tick();
    await sleep(20);
    expect((await jobRows())[0]?.attempts).toBe(1);

    timer.advance(10_000);
    timer.tick();
    await expect.poll(async () => (await jobRows())[0]?.attempts).toBe(2);
    const [second] = await jobRows();
    expect(second!.runAfter.getTime() - timer.clock.now().getTime()).toBe(60_000);
    expect(failedLabels).toEqual([]);

    timer.advance(60_000);
    timer.tick();

    await expect.poll(() => statusOf("test.fail")).toBe("failed");
    const [last] = await jobRows();
    expect(last).toMatchObject({ attempts: 3, lastError: "boom" });
    expect(failedLabels).toEqual(["a"]);
    await runner.stop();
  });

  it("fails a job at once on a PermanentJobError", async () => {
    const timer = fakeClock();
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: timer.clock,
    });
    failure = new PermanentJobError("no text layer");
    await runner.enqueue("test.fail", { label: "a" });
    await runner.start();

    await expect.poll(() => statusOf("test.fail")).toBe("failed");
    const [row] = await jobRows();
    expect(row).toMatchObject({ attempts: 1, lastError: "no text layer" });
    expect(failedLabels).toEqual(["a"]);
    await runner.stop();
  });
});

describe("drainJobs", () => {
  it("runs every queued job, and the jobs they enqueue, until none are left", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: fakeClock().clock,
    });
    await runner.enqueue("test.record", { label: "a" });
    await runner.enqueue("test.record", { label: "b" });

    expect(await drainJobs()).toBe(2);

    expect(ran).toEqual(["a", "b"]);
    expect((await jobRows()).map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("ignores retry backoff by default, so a failing job ends failed within one drain", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: fakeClock().clock,
    });
    failure = new Error("boom");
    await runner.enqueue("test.fail", { label: "a" });

    expect(await drainJobs()).toBe(3);

    expect(await statusOf("test.fail")).toBe("failed");
    expect(failedLabels).toEqual(["a"]);
  });

  it("with respectRunAfter, leaves a job in its backoff alone", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      deps: testDeps,
      clock: fakeClock().clock,
    });
    failure = new Error("boom");
    // drainJobs compares run_after with the real time, so this job is due now.
    await runner.enqueue("test.fail", { label: "a" }, { runAfter: new Date(Date.now() - 1_000) });
    expect(await drainJobs({ respectRunAfter: true })).toBe(1);

    expect(await drainJobs({ respectRunAfter: true })).toBe(0);
    expect(await statusOf("test.fail")).toBe("queued");
  });
});

describe("createChat({ jobs })", () => {
  it("starts and stops the Host's runner with chat.start() and chat.stop()", async () => {
    const jobs: JobRunner = {
      enqueue: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const chat = createChat({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath: "/api/chat",
      logger: silent,
      jobs,
    });

    await chat.start();
    expect(jobs.start).toHaveBeenCalledTimes(1);

    await chat.stop();
    expect(jobs.stop).toHaveBeenCalledTimes(1);
  });
});
