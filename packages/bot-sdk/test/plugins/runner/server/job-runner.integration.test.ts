import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildBotSdk } from "../../../../core/server/create-chat";
import { models } from "../../../../plugins/models/server/internal";
import { job } from "../../../../core/server/storage";
import {
  type JobDefinition,
  jobTable,
  type JobTable,
  PermanentJobError,
  inProcessRunner,
  cancelJob,
  createJobRunner,
  claimJob,
  pruneFinishedJobs,
  reapStaleJobs,
} from "../../../../plugins/runner/server/internal";
import type { Executor, JobRunner } from "../../../../plugins/runner/server/internal";
import { drainJobs, fakeJobClock } from "../../../support/jobs";
import { getTestDb, testDatabaseUrl } from "../../../support/test-database";

const start = new Date("2026-10-14T10:00:00Z");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { error: () => {} };
/** The jobs this file defines, which its runners run. They take no core services. */
// oxlint-disable-next-line typescript/no-explicit-any -- each job has its own payload
const testJobs: JobDefinition<any, object>[] = [];
const listed = <P>(definition: JobDefinition<P, object> & { budget?: string }) => {
  testJobs.push(definition);
  return definition;
};
let table: JobTable | undefined;
const testTable = () => (table ??= jobTable([{ jobs: testJobs, services: {} }]));
const DAY = 86_400_000;

// Test-only jobs. Each test sets their behaviour through these variables.
const ran: string[] = [];
const started: string[] = [];
const failedLabels: string[] = [];
const aborted: string[] = [];
const cancelledLabels: string[] = [];
let failure: unknown;
let gate: Promise<void> | undefined;
/** While true, `test.hold` runs until its attempt is aborted, or until `releaseHold()`. */
let holding = false;
let releaseHold: (() => void) | undefined;

listed({
  name: "test.record",
  payload: z.object({ label: z.string() }),
  run: async ({ label }) => {
    started.push(label);
    await gate;
    ran.push(label);
  },
});

listed({
  name: "test.fail",
  payload: z.object({ label: z.string() }),
  run: async () => {
    if (failure) throw failure;
  },
  onFailed: ({ label }) => {
    failedLabels.push(label);
  },
});

listed({
  name: "test.hold",
  payload: z.object({ label: z.string() }),
  run: async ({ label }, { signal }) => {
    if (!holding) {
      ran.push(label);
      return;
    }
    started.push(label);
    await new Promise<void>((resolve, reject) => {
      releaseHold = resolve;
      signal.addEventListener(
        "abort",
        () => {
          aborted.push(label);
          reject(signal.reason);
        },
        { once: true },
      );
    });
    ran.push(label);
  },
  onCancelled: ({ label }) => {
    cancelledLabels.push(label);
  },
});

/** Released by the test that runs `test.linger`; until then its handler goes on after its abort. */
let lingerGate: Promise<void> | undefined;

listed({
  name: "test.linger",
  payload: z.object({ label: z.string() }),
  run: async ({ label }, { signal }) => {
    started.push(label);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    // Work a handler does after its attempt is aborted, such as ending a Turn.
    await lingerGate;
    ran.push(label);
  },
});

listed({
  name: "test.self-cancel",
  payload: z.object({ label: z.string() }),
  run: async ({ label }, ctx) => {
    // A cancel commits while the job runs, so its next Checkpoint finds its row gone.
    await cancelJob(getTestDb(), label, new Date());
    try {
      await ctx.step("after-cancel", async () => label);
    } catch {
      // The attempt has lost its job; the handler goes on, as a Turn's ends its Turn.
    }
    await lingerGate;
    ran.push(label);
  },
});

/** Released by the test that holds `test.helper` jobs; until then each one keeps running. */
let helperGate: Promise<void> | undefined;

for (const name of ["test.helper", "test.capture"]) {
  listed({
    name,
    // One budget of four, as the Helpers and the Demonstration captures share (#602).
    budget: "helper",
    concurrency: 4,
    payload: z.object({ label: z.string() }),
    run: async ({ label }) => {
      started.push(label);
      await helperGate;
      ran.push(label);
    },
  });
}

/** Every `chat.job` row, read straight from the test database. */
const jobRows = () => getTestDb().select().from(job);

/** The first job's attempts and status as `"<attempts>:<status>"`, to poll on both at once. */
async function attemptAndStatus() {
  const [row] = await jobRows();
  return row && `${row.attempts}:${row.status}`;
}

/** The status of the job with this name, or undefined when there is none. */
async function statusOf(name: string) {
  const [row] = await getTestDb().select().from(job).where(eq(job.name, name));
  return row?.status;
}

beforeEach(() => {
  ran.length = 0;
  started.length = 0;
  failedLabels.length = 0;
  aborted.length = 0;
  cancelledLabels.length = 0;
  failure = undefined;
  gate = undefined;
  holding = false;
  releaseHold = undefined;
  helperGate = undefined;
  lingerGate = undefined;
});

afterEach(() => {
  failure = undefined;
  gate = undefined;
  holding = false;
});

describe("enqueue", () => {
  it("stores a queued job with its payload and the default retry settings", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
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
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });

    await runner.enqueue("test.record", { label: "a" }, { idempotencyKey: "k1" });
    await runner.enqueue("test.record", { label: "b" }, { idempotencyKey: "k1" });
    expect(await jobRows()).toHaveLength(1);

    await drainJobs({ jobs: testTable() });
    await runner.enqueue("test.record", { label: "c" }, { idempotencyKey: "k1" });
    expect(await jobRows()).toHaveLength(2);
  });

  it("honours runAfter", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
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
      jobs: testTable,
      clock: fakeJobClock(start).clock,
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
      jobs: testTable,
      clock: fakeJobClock(start).clock,
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
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    await runner.start();

    await runner.enqueue("test.record", { label: "a" });

    await expect.poll(() => ran).toEqual(["a"]);
    await runner.stop();
  });

  it("polls on its timer for a job another process queued", async () => {
    const timer = fakeJobClock(start);
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: timer.clock,
    });
    await runner.start();
    const otherProcess = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
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
      jobs: testTable,
      clock: fakeJobClock(start).clock,
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

  it("runs a job while four jobs with their own budget of four are running", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    let releaseHelpers!: () => void;
    helperGate = new Promise((resolve) => {
      releaseHelpers = resolve;
    });
    const helpers = ["h1", "h2", "h3", "h4"];
    for (const label of helpers) await runner.enqueue("test.helper", { label });

    await runner.start();
    await expect.poll(() => started.length).toBe(4);
    await runner.enqueue("test.record", { label: "turn" });

    await expect.poll(() => ran).toEqual(["turn"]);
    releaseHelpers();
    await expect.poll(() => ran.length).toBe(5);
    await runner.stop();
  });

  it("holds a job with a concurrency to its own budget: four of it and two others at once", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    let releaseHelpers!: () => void;
    helperGate = new Promise((resolve) => {
      releaseHelpers = resolve;
    });
    let releaseOthers!: () => void;
    gate = new Promise((resolve) => {
      releaseOthers = resolve;
    });
    for (const label of ["h1", "h2", "h3", "h4", "h5"]) {
      await runner.enqueue("test.helper", { label });
    }
    for (const label of ["a", "b", "c"]) await runner.enqueue("test.record", { label });

    await runner.start();
    await expect.poll(() => started.length).toBe(6);
    await sleep(50);
    expect(started.filter((label) => label.startsWith("h"))).toHaveLength(4);
    expect(started.filter((label) => !label.startsWith("h"))).toHaveLength(2);

    releaseHelpers();
    await expect.poll(() => ran.filter((label) => label.startsWith("h"))).toHaveLength(5);
    expect(started.filter((label) => !label.startsWith("h"))).toHaveLength(2);
    releaseOthers();
    await expect.poll(() => ran.length).toBe(8);
    await runner.stop();
  });

  it("holds the jobs of one budget to it together: four of them at once", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    let releaseHelpers!: () => void;
    helperGate = new Promise((resolve) => {
      releaseHelpers = resolve;
    });
    for (const label of ["h1", "h2", "h3"]) await runner.enqueue("test.helper", { label });
    for (const label of ["c1", "c2", "c3"]) await runner.enqueue("test.capture", { label });

    await runner.start();
    await expect.poll(() => started.length).toBe(4);
    await sleep(50);
    expect(started).toHaveLength(4);

    releaseHelpers();
    await expect.poll(() => ran.length).toBe(6);
    await runner.stop();
  });

  it("never runs the same job twice when two runners share one database", async () => {
    const { clock } = fakeJobClock(start);
    const db = getTestDb();
    const runners: JobRunner[] = [
      inProcessRunner({ db, logger: silent, jobs: testTable, clock, concurrency: 4 }),
      inProcessRunner({ db, logger: silent, jobs: testTable, clock, concurrency: 4 }),
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
    const timer = fakeJobClock(start);
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: timer.clock,
    });
    failure = new Error("boom");
    await runner.enqueue("test.fail", { label: "a" });
    await runner.start();

    // `attempts` goes up when the job is claimed, before the failure is written: wait for both.
    await expect.poll(attemptAndStatus).toBe("1:queued");
    const [first] = await jobRows();
    expect(first).toMatchObject({ status: "queued", lastError: "boom" });
    expect(first!.runAfter.getTime() - timer.clock.now().getTime()).toBe(10_000);

    timer.tick();
    await sleep(20);
    expect((await jobRows())[0]?.attempts).toBe(1);

    timer.advance(10_000);
    timer.tick();
    await expect.poll(attemptAndStatus).toBe("2:queued");
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
    const timer = fakeJobClock(start);
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
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
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    await runner.enqueue("test.record", { label: "a" });
    await runner.enqueue("test.record", { label: "b" });

    expect(await drainJobs({ jobs: testTable() })).toBe(2);

    expect(ran).toEqual(["a", "b"]);
    expect((await jobRows()).map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("returns only once a lost attempt's handler has ended", async () => {
    let release!: () => void;
    lingerGate = new Promise((resolve) => {
      release = resolve;
    });
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    await runner.enqueue("test.self-cancel", { label: "a" }, { idempotencyKey: "a" });

    let drained = false;
    const draining = drainJobs({ jobs: testTable() }).then((count) => {
      drained = true;
      return count;
    });
    await sleep(100);
    expect(drained).toBe(false);
    release();

    expect(await draining).toBe(1);
    expect(ran).toEqual(["a"]);
  });

  it("ignores retry backoff by default, so a failing job ends failed within one drain", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    failure = new Error("boom");
    await runner.enqueue("test.fail", { label: "a" });

    expect(await drainJobs({ jobs: testTable() })).toBe(3);

    expect(await statusOf("test.fail")).toBe("failed");
    expect(failedLabels).toEqual(["a"]);
  });

  it("with respectRunAfter, leaves a job in its backoff alone", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    failure = new Error("boom");
    // drainJobs compares run_after with the real time, so this job is due now.
    await runner.enqueue("test.fail", { label: "a" }, { runAfter: new Date(Date.now() - 1_000) });
    expect(await drainJobs({ respectRunAfter: true, jobs: testTable() })).toBe(1);

    expect(await drainJobs({ respectRunAfter: true, jobs: testTable() })).toBe(0);
    expect(await statusOf("test.fail")).toBe("queued");
  });
});

describe("heartbeats and leases", () => {
  it("heartbeats every 10 s while a job runs", async () => {
    const timer = fakeJobClock(start);
    holding = true;
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: timer.clock,
      drainMs: 20,
    });
    await runner.enqueue("test.hold", { label: "a" });

    await runner.start();

    await expect.poll(() => statusOf("test.hold")).toBe("running");
    expect(timer.intervals).toContain(10_000);
    timer.advance(10_000);
    timer.tick();
    await expect
      .poll(async () => (await jobRows())[0]?.heartbeatAt?.getTime())
      .toBe(start.getTime() + 10_000);
    await runner.stop();
  });

  it("re-queues a job whose lease expired after 60 s, and the attempt counts", async () => {
    const timer = fakeJobClock(start);
    holding = true;
    const crashed = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: timer.clock,
      drainMs: 20,
    });
    await crashed.enqueue("test.hold", { label: "a" });
    await crashed.start();
    await expect.poll(() => statusOf("test.hold")).toBe("running");
    // Stopping leaves the lease behind, as a crash would.
    await crashed.stop();
    holding = false;

    timer.advance(60_000);
    await reapStaleJobs(getTestDb(), timer.clock.now(), silent, testTable());
    expect(await statusOf("test.hold")).toBe("running");

    timer.advance(1_000);
    await reapStaleJobs(getTestDb(), timer.clock.now(), silent, testTable());
    expect(await jobRows()).toMatchObject([
      { status: "queued", attempts: 1, lastError: expect.stringContaining("lease") },
    ]);

    expect(await drainJobs({ jobs: testTable() })).toBe(1);
    expect(ran).toEqual(["a"]);
    expect(await jobRows()).toMatchObject([{ status: "succeeded", attempts: 2 }]);
  });

  it("fails a job whose lease expires on its last attempt, and runs onFailed", async () => {
    const timer = fakeJobClock(start);
    const db = getTestDb();
    const runner = inProcessRunner({ db, logger: silent, jobs: testTable, clock: timer.clock });
    await runner.enqueue("test.fail", { label: "a" });
    // Three processes claim the job and die without finishing it.
    for (const attempt of [1, 2, 3]) {
      expect(await claimJob(db, timer.clock.now())).toMatchObject({ attempts: attempt });
      timer.advance(61_000);
      await reapStaleJobs(db, timer.clock.now(), silent, testTable());
    }

    expect(await jobRows()).toMatchObject([
      { status: "failed", attempts: 3, lastError: expect.stringContaining("lease") },
    ]);
    expect(failedLabels).toEqual(["a"]);
  });

  it("ignores a lost attempt that ends after another attempt has claimed its job", async () => {
    const timer = fakeJobClock(start);
    const db = getTestDb();
    holding = true;
    const lost = inProcessRunner({
      db,
      logger: silent,
      jobs: testTable,
      clock: timer.clock,
      drainMs: 2_000,
    });
    await lost.enqueue("test.hold", { label: "a" });
    await lost.start();
    await expect.poll(() => statusOf("test.hold")).toBe("running");
    timer.advance(61_000);
    await reapStaleJobs(db, timer.clock.now(), silent, testTable());
    expect(await claimJob(db, timer.clock.now())).toMatchObject({ attempts: 2 });

    releaseHold?.();
    await lost.stop();

    expect(await jobRows()).toMatchObject([{ status: "running", attempts: 2 }]);
  });

  it("ends an attempt that runs past 15 minutes as a failure, and retries it", async () => {
    const timer = fakeJobClock(start);
    holding = true;
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: timer.clock,
      drainMs: 20,
    });
    await runner.enqueue("test.hold", { label: "a" });
    await runner.start();
    await expect.poll(() => statusOf("test.hold")).toBe("running");

    timer.advance(15 * 60_000);
    timer.tick();

    await expect.poll(() => statusOf("test.hold")).toBe("queued");
    expect(aborted).toEqual(["a"]);
    expect(await jobRows()).toMatchObject([
      { attempts: 1, lastError: "Timed out after 15 minutes" },
    ]);
    await runner.stop();
  });
});

describe("cancel", () => {
  it("drops a queued job, so it never runs", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    await runner.enqueue("test.record", { label: "a" }, { idempotencyKey: "k" });

    await runner.cancel("k");

    expect(await drainJobs({ jobs: testTable() })).toBe(0);
    expect(ran).toEqual([]);
    expect(await statusOf("test.record")).toBe("cancelled");
  });

  it("aborts a running job at its next heartbeat, and the handler sees the signal", async () => {
    const timer = fakeJobClock(start);
    holding = true;
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: timer.clock,
      drainMs: 20,
    });
    await runner.enqueue("test.hold", { label: "a" }, { idempotencyKey: "k" });
    await runner.start();
    await expect.poll(() => statusOf("test.hold")).toBe("running");

    await runner.cancel("k");
    expect(await statusOf("test.hold")).toBe("cancelled");
    expect(aborted).toEqual([]);

    timer.advance(10_000);
    timer.tick();

    await expect.poll(() => aborted).toEqual(["a"]);
    expect(await jobRows()).toMatchObject([{ status: "cancelled", attempts: 1 }]);
    await runner.stop();
  });
  it("calls onCancelled from the sweep, exactly once, for a cancelled job whose attempt lost its lease", async () => {
    const timer = fakeJobClock(start);
    const db = getTestDb();
    const runner = inProcessRunner({ db, logger: silent, jobs: testTable, clock: timer.clock });
    await runner.enqueue("test.hold", { label: "a" }, { idempotencyKey: "k" });
    // A process claims the job and dies without running any more of it.
    expect(await claimJob(db, timer.clock.now())).toMatchObject({ attempts: 1 });
    await runner.cancel("k");

    timer.advance(60_000);
    await reapStaleJobs(db, timer.clock.now(), silent, testTable());
    expect(cancelledLabels).toEqual([]);

    timer.advance(1_000);
    await reapStaleJobs(db, timer.clock.now(), silent, testTable());
    await reapStaleJobs(db, timer.clock.now(), silent, testTable());

    expect(cancelledLabels).toEqual(["a"]);
    expect(await jobRows()).toMatchObject([{ status: "cancelled", attempts: 1 }]);
  });

  it("never calls onCancelled for a job whose attempt saw the cancel and ended", async () => {
    const timer = fakeJobClock(start);
    holding = true;
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: timer.clock,
      drainMs: 20,
    });
    await runner.enqueue("test.hold", { label: "a" }, { idempotencyKey: "k" });
    await runner.start();
    await expect.poll(() => statusOf("test.hold")).toBe("running");
    await runner.cancel("k");
    timer.advance(10_000);
    timer.tick();
    await expect.poll(() => aborted).toEqual(["a"]);
    await expect.poll(async () => (await jobRows())[0]?.heartbeatAt).toBeNull();
    await runner.stop();

    timer.advance(61_000);
    await reapStaleJobs(getTestDb(), timer.clock.now(), silent, testTable());

    expect(cancelledLabels).toEqual([]);
  });

  it("calls onCancelled for a cancelled job whose handler ended before its attempt saw the cancel", async () => {
    const timer = fakeJobClock(start);
    holding = true;
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: timer.clock,
    });
    await runner.enqueue("test.hold", { label: "a" }, { idempotencyKey: "k" });
    await runner.start();
    await expect.poll(() => statusOf("test.hold")).toBe("running");
    await runner.cancel("k");

    // The handler ends on its own, before a heartbeat tells it of the cancel.
    releaseHold?.();
    await expect.poll(() => ran).toEqual(["a"]);
    await runner.stop();
    timer.advance(61_000);
    await reapStaleJobs(getTestDb(), timer.clock.now(), silent, testTable());

    expect(cancelledLabels).toEqual(["a"]);
  });

  it("never calls onCancelled for a job cancelled while it waited to retry", async () => {
    const timer = fakeJobClock(start);
    const db = getTestDb();
    const runner = inProcessRunner({ db, logger: silent, jobs: testTable, clock: timer.clock });
    await runner.enqueue("test.hold", { label: "a" }, { idempotencyKey: "k" });
    expect(await claimJob(db, timer.clock.now())).toMatchObject({ attempts: 1 });
    timer.advance(61_000);
    await reapStaleJobs(db, timer.clock.now(), silent, testTable());
    expect(await statusOf("test.hold")).toBe("queued");

    await runner.cancel("k");
    timer.advance(61_000);
    await reapStaleJobs(db, timer.clock.now(), silent, testTable());

    expect(cancelledLabels).toEqual([]);
  });
});

describe("status", () => {
  it("returns a job's state by id, and the active job's id for a repeated key", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    const id = await runner.enqueue("test.record", { label: "a" }, { idempotencyKey: "k" });

    expect(await runner.enqueue("test.record", { label: "b" }, { idempotencyKey: "k" })).toBe(id);
    expect(await runner.status(id)).toMatchObject({
      id,
      name: "test.record",
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
    });
    expect(await runner.status("0195c0a2-0000-7000-8000-000000000000")).toBeUndefined();
  });
});

describe("stop", () => {
  it("waits up to drainMs for a running job, then aborts it and leaves its lease", async () => {
    const timer = fakeJobClock(start);
    holding = true;
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: timer.clock,
      drainMs: 20,
    });
    await runner.enqueue("test.hold", { label: "a" });
    await runner.start();
    await expect.poll(() => statusOf("test.hold")).toBe("running");
    const heartbeatBefore = (await jobRows())[0]?.heartbeatAt;

    await runner.stop();

    expect(aborted).toEqual(["a"]);
    expect(await jobRows()).toMatchObject([{ status: "running", attempts: 1 }]);
    // Nothing heartbeats after stop, so the lease runs out for another process to reap.
    timer.advance(10_000);
    timer.tick();
    expect((await jobRows())[0]?.heartbeatAt).toEqual(heartbeatBefore);
  });

  it("lets a job that finishes within drainMs complete", async () => {
    let release!: () => void;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
      drainMs: 2_000,
    });
    await runner.enqueue("test.record", { label: "a" });
    await runner.start();
    await expect.poll(() => started).toEqual(["a"]);

    const stopping = runner.stop();
    release();
    await stopping;

    expect(ran).toEqual(["a"]);
    expect(await statusOf("test.record")).toBe("succeeded");
  });
});

describe("stop and lost attempts", () => {
  /** A started runner whose `test.linger` job has lost its attempt to a cancel. */
  async function lostAttempt(drainMs: number, logger = silent) {
    const timer = fakeJobClock(start);
    const runner = inProcessRunner({
      db: getTestDb(),
      logger,
      jobs: testTable,
      clock: timer.clock,
      concurrency: 1,
      drainMs,
    });
    await runner.enqueue("test.linger", { label: "a" }, { idempotencyKey: "k" });
    await runner.start();
    await expect.poll(() => started).toEqual(["a"]);
    // Waits for the only slot, which the attempt frees once it has lost its job.
    await runner.enqueue("test.record", { label: "b" });
    await runner.cancel("k");
    timer.advance(10_000);
    timer.tick();
    await expect.poll(() => ran).toEqual(["b"]);
    return runner;
  }

  it("waits for a lost attempt's handler to end", async () => {
    let release!: () => void;
    lingerGate = new Promise((resolve) => {
      release = resolve;
    });
    const runner = await lostAttempt(2_000);

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await sleep(50);
    expect(stopped).toBe(false);
    release();
    await stopping;

    expect(ran).toEqual(["b", "a"]);
    // Its last write, acknowledging the cancel, is done too.
    const [linger] = await getTestDb().select().from(job).where(eq(job.name, "test.linger"));
    expect(linger).toMatchObject({ status: "cancelled", heartbeatAt: null });
  });

  it("stops waiting for a handler that never ends, drainMs after aborting it", async () => {
    lingerGate = new Promise(() => {});
    const logger = { error: vi.fn() };
    const runner = await lostAttempt(20, logger);

    const stopping = Date.now();
    await runner.stop();

    expect(Date.now() - stopping).toBeLessThan(1_000);
    expect(ran).toEqual(["b"]);
    expect(logger.error).toHaveBeenCalledWith(
      "1 background job handler(s) still running after stop",
    );
  });
});

describe("retention", () => {
  it("deletes succeeded and cancelled jobs 7 days after they end, and failed jobs 30 days after", async () => {
    const db = getTestDb();
    const runner = inProcessRunner({
      db,
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });
    const endedAgo = async (
      status: "succeeded" | "cancelled" | "failed" | "queued",
      days: number,
    ) => {
      const id = await runner.enqueue("test.record", { label: `${status}-${days}` });
      await db
        .update(job)
        .set({ status, updatedAt: new Date(start.getTime() - days * DAY) })
        .where(eq(job.id, id));
      return id;
    };
    const kept = [
      await endedAgo("succeeded", 6),
      await endedAgo("failed", 29),
      await endedAgo("queued", 400),
    ];
    await endedAgo("succeeded", 8);
    await endedAgo("cancelled", 8);
    await endedAgo("failed", 31);

    await pruneFinishedJobs(db, start);

    expect((await jobRows()).map((row) => row.id).sort()).toEqual([...kept].sort());
  });
});

describe("schedule", () => {
  it("is not supported by the in-process runner yet", async () => {
    const runner = inProcessRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      clock: fakeJobClock(start).clock,
    });

    await expect(runner.schedule("test.record", { everyMs: 60_000 })).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("the runner slot", () => {
  it("starts and stops the Host's Executor with chat.start() and chat.stop()", async () => {
    const jobs: Executor = {
      start: vi.fn(async () => {}),
      notify: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    // Models alone, without the Bots, which refuse a runner other than the in-process one.
    const chat = buildBotSdk(
      {
        databaseUrl: testDatabaseUrl,
        keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
        logger: silent,
        models: {},
        runner: jobs,
      },
      {},
      [models()],
    ).instance;

    await chat.start();
    expect(jobs.start).toHaveBeenCalledTimes(1);

    await chat.stop();
    expect(jobs.stop).toHaveBeenCalledTimes(1);
  });
});

describe("an Executor whose notify throws", () => {
  it("still commits the enqueue, and logs the failure", async () => {
    const logged = vi.fn();
    const jobs = createJobRunner({
      db: getTestDb(),
      logger: { error: logged },
      jobs: testTable,
      executor: {
        start: async () => {},
        notify: () => {
          throw new Error("unreachable queue");
        },
        stop: async () => {},
      },
    });

    const id = await getTestDb().transaction((tx) =>
      jobs.enqueueIn(tx, "test.record", { label: "a" }),
    );
    await jobs.enqueue("test.record", { label: "b" });

    expect((await jobs.status(id))?.status).toBe("queued");
    expect(await jobRows()).toHaveLength(2);
    await expect.poll(() => logged.mock.calls.length).toBe(2);
  });
});
