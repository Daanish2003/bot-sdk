import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createJobRunner,
  type JobDefinition,
  jobTable,
  type JobTable,
  type Executor,
  inProcessExecutor,
  type JobRunner,
  reapStaleJobs,
} from "../../../../plugins/runner/server/internal";
import { manualExecutor, recordingNotify } from "../../../support/executors";
import { fakeJobClock } from "../../../support/jobs";
import { getTestDb } from "../../../support/test-database";

/*
 * The Executor conformance suite (spec #872): what every Executor must give, run against the
 * in-process Executor and against a manual one, where the test decides when the core's `run` is
 * called. Each case enqueues jobs and observes outcomes: what ran, the job's status, and what the
 * Executor was notified of.
 */

const silent = { error: () => {} };
const poll = { timeout: 10_000 };
/** The jobs this file defines, which its runners run. They take no core services. */
// oxlint-disable-next-line typescript/no-explicit-any -- each job has its own payload
const testJobs: JobDefinition<any, object>[] = [];
const listed = <P>(definition: JobDefinition<P, object>) => {
  testJobs.push(definition);
  return definition;
};
let table: JobTable | undefined;
const testTable = () => (table ??= jobTable([{ jobs: testJobs, services: {} }]));

const ran: string[] = [];
const started: string[] = [];
const aborted: string[] = [];
const steps = { a: 0, b: 0 };
const fires: string[] = [];
let gate: Promise<void> | undefined;
/** The runner the recurring job queues its next slot on. */
let current: JobRunner | undefined;

listed({
  name: "conformance.record",
  payload: z.object({ label: z.string() }),
  run: async ({ label }) => {
    started.push(label);
    await gate;
    ran.push(label);
  },
});

listed({
  name: "conformance.steps",
  payload: z.object({ label: z.string() }),
  run: async ({ label }, ctx) => {
    await ctx.step("a", async () => {
      steps.a += 1;
    });
    started.push(label);
    // A crash: the process stops here, and the handler never sees its abort.
    await gate;
    await ctx.step("b", async () => {
      steps.b += 1;
    });
    ran.push(label);
  },
});

listed({
  name: "conformance.hold",
  payload: z.object({ label: z.string() }),
  run: async ({ label }, { signal }) => {
    started.push(label);
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => {
          aborted.push(label);
          reject(signal.reason);
        },
        { once: true },
      ),
    );
  },
});

let failures = 0;

listed({
  name: "conformance.fail-once",
  payload: z.object({ label: z.string() }),
  run: async ({ label }) => {
    started.push(label);
    failures += 1;
    if (failures === 1) throw new Error("The first attempt fails");
    ran.push(label);
  },
});

const SLOT_MS = 60_000;
const recurKey = (slot: string) => `conformance.recur:${slot}`;

listed({
  name: "conformance.recur",
  payload: z.object({ slot: z.iso.datetime() }),
  run: async ({ slot }, ctx) => {
    // The fire and the next slot's job commit with this Checkpoint, or not at all.
    await ctx.step("fire", async (tx) => {
      fires.push(slot);
      const next = new Date(new Date(slot).getTime() + SLOT_MS).toISOString();
      await current!.enqueueIn(
        tx,
        "conformance.recur",
        { slot: next },
        { idempotencyKey: recurKey(next), runAfter: new Date(next) },
      );
    });
  },
});

type Harness = {
  executor: Executor;
  /** Each `notify` the core sent the Executor. */
  notified: { jobId: string; runAfter?: Date }[];
  /** Has the Executor run the job now: the in-process one is woken, the manual one calls `run`. */
  deliver: (jobId: string) => Promise<void>;
};

const executors: { name: string; build: (clock: ReturnType<typeof fakeJobClock>) => Harness }[] = [
  {
    name: "the in-process Executor",
    build: (timer) => {
      const inProcess = inProcessExecutor({ logger: silent, clock: timer.clock });
      const { executor, notified } = recordingNotify(inProcess);
      return { executor, notified, deliver: (jobId) => inProcess.notify(jobId) };
    },
  },
  {
    name: "a manual Executor",
    build: () => {
      const manual = manualExecutor();
      return { executor: manual.executor, notified: manual.notified, deliver: manual.run };
    },
  },
];

describe.each(executors)("$name", ({ build }) => {
  const runners: JobRunner[] = [];
  let timer: ReturnType<typeof fakeJobClock>;
  let harness: Harness;
  let jobs: JobRunner;

  /** A runner over the test database, the Executor `executor` and the clock `clock`. */
  const runnerOver = async (executor: Executor, clock = timer.clock) => {
    const runner = createJobRunner({
      db: getTestDb(),
      logger: silent,
      jobs: testTable,
      executor,
      clock,
      drainMs: 20,
    });
    runners.push(runner);
    await runner.start();
    return runner;
  };

  beforeEach(async () => {
    for (const list of [ran, started, aborted, fires]) list.length = 0;
    failures = 0;
    steps.a = 0;
    steps.b = 0;
    gate = undefined;
    timer = fakeJobClock(new Date());
    harness = build(timer);
    jobs = await runnerOver(harness.executor);
    current = jobs;
  });

  afterEach(async () => {
    for (const runner of runners.splice(0)) await runner.stop();
    current = undefined;
  });

  it(
    "runs a job queued in a transaction only after the transaction commits",
    { timeout: 30_000 },
    async () => {
      let id = "";
      await getTestDb().transaction(async (tx) => {
        id = await jobs.enqueueIn(tx, "conformance.record", { label: "a" });
        await harness.deliver(id);
        expect(harness.notified).toEqual([]);
      });
      expect(ran).toEqual([]);
      expect(harness.notified).toEqual([{ jobId: id }]);

      await harness.deliver(id);

      await expect.poll(() => ran, poll).toEqual(["a"]);
      await expect.poll(async () => (await jobs.status(id))?.status, poll).toBe("succeeded");
    },
  );

  it("never runs a job whose enqueueing transaction rolled back", { timeout: 30_000 }, async () => {
    let id = "";
    await expect(
      getTestDb().transaction(async (tx) => {
        id = await jobs.enqueueIn(tx, "conformance.record", { label: "a" });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    await harness.deliver(id);

    expect(harness.notified).toEqual([]);
    expect(ran).toEqual([]);
    expect(await jobs.status(id)).toBeUndefined();
  });

  it(
    "fences a second concurrent run of the same job, so its work runs once",
    { timeout: 30_000 },
    async () => {
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      const id = await jobs.enqueue("conformance.record", { label: "a" });

      const runs = [harness.deliver(id), harness.deliver(id)];
      await expect.poll(() => started, poll).toEqual(["a"]);
      // And once more while the first run holds the job.
      await harness.deliver(id);
      expect(started).toEqual(["a"]);
      open();
      await Promise.all(runs);

      await expect.poll(async () => (await jobs.status(id))?.status, poll).toBe("succeeded");
      expect(started).toEqual(["a"]);
      expect(ran).toEqual(["a"]);
    },
  );

  it("resumes a job after a crash from its last Checkpoint", { timeout: 30_000 }, async () => {
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    // The process that crashes: its clock is 2 minutes behind, so its lease has expired by now.
    const crashed = manualExecutor();
    const elsewhere = await runnerOver(
      crashed.executor,
      fakeJobClock(new Date(timer.clock.now().getTime() - 2 * SLOT_MS)).clock,
    );
    const id = await elsewhere.enqueue("conformance.steps", { label: "a" });
    void crashed.run(id);
    await expect.poll(() => started, poll).toEqual(["a"]);
    // It stops without the handler seeing its abort, and leaves its lease to expire.
    await elsewhere.stop();
    await reapStaleJobs(getTestDb(), timer.clock.now(), silent, testTable());

    gate = undefined;
    await harness.deliver(id);

    await expect.poll(() => ran, poll).toEqual(["a"]);
    await expect.poll(async () => (await jobs.status(id))?.status, poll).toBe("succeeded");
    expect(steps).toEqual({ a: 1, b: 1 });
    open();
  });

  it(
    "aborts a running job through its signal when it is cancelled",
    { timeout: 30_000 },
    async () => {
      const id = await jobs.enqueue("conformance.hold", { label: "a" }, { idempotencyKey: "hold" });
      const run = harness.deliver(id);
      await expect.poll(() => started, poll).toEqual(["a"]);

      await jobs.cancel("hold");
      // The next heartbeat finds the job cancelled.
      timer.tick();

      await expect.poll(() => aborted, poll).toEqual(["a"]);
      await run;
      expect((await jobs.status(id))?.status).toBe("cancelled");
    },
  );

  it("respects runAfter", { timeout: 30_000 }, async () => {
    const runAfter = new Date(timer.clock.now().getTime() + SLOT_MS);
    const id = await jobs.enqueue("conformance.record", { label: "a" }, { runAfter });
    expect(harness.notified).toEqual([{ jobId: id, runAfter }]);

    await harness.deliver(id);
    expect(ran).toEqual([]);
    expect((await jobs.status(id))?.status).toBe("queued");

    timer.advance(SLOT_MS);
    await harness.deliver(id);

    await expect.poll(() => ran, poll).toEqual(["a"]);
  });

  describe("replaceIfNotStarted", () => {
    /** Replaces the job with key `key` by a `conformance.record` labelled `label`, in a transaction. */
    const replace = (key: string, label: string, runAfter?: Date) =>
      getTestDb().transaction((tx) =>
        jobs.replaceIfNotStarted(tx, key, "conformance.record", { label }, { runAfter }),
      );

    it(
      "replaces a queued job that hasn't started, notifying only once it commits",
      { timeout: 30_000 },
      async () => {
        // Not due yet, so that the in-process Executor doesn't start it at once.
        const later = new Date(timer.clock.now().getTime() + 1_000);
        const old = await jobs.enqueue(
          "conformance.record",
          { label: "old" },
          { idempotencyKey: "turn", runAfter: later },
        );
        const runAfter = new Date(later.getTime() + 1_000);

        let replacement: string | undefined;
        await getTestDb().transaction(async (tx) => {
          replacement = await jobs.replaceIfNotStarted(
            tx,
            "turn",
            "conformance.record",
            { label: "new" },
            { runAfter },
          );
          expect(harness.notified).toEqual([{ jobId: old, runAfter: later }]);
        });

        expect(replacement).toEqual(expect.any(String));
        expect(replacement).not.toBe(old);
        expect(harness.notified).toEqual([
          { jobId: old, runAfter: later },
          { jobId: replacement, runAfter },
        ]);
        expect((await jobs.status(old))?.status).toBe("cancelled");
        expect((await jobs.status(replacement!))?.runAfter).toEqual(runAfter);
        // The replacement holds the key, as the job it replaced did.
        expect(
          await jobs.enqueue("conformance.record", { label: "x" }, { idempotencyKey: "turn" }),
        ).toBe(replacement);

        timer.advance(2_000);
        await harness.deliver(old);
        await harness.deliver(replacement!);
        await expect.poll(() => ran, poll).toEqual(["new"]);
        expect((await jobs.status(old))?.status).toBe("cancelled");
      },
    );

    it("keeps the job when the replacing transaction rolls back", { timeout: 30_000 }, async () => {
      const later = new Date(timer.clock.now().getTime() + 1_000);
      const old = await jobs.enqueue(
        "conformance.record",
        { label: "old" },
        { idempotencyKey: "turn", runAfter: later },
      );
      await expect(
        getTestDb().transaction(async (tx) => {
          await jobs.replaceIfNotStarted(tx, "turn", "conformance.record", { label: "new" });
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");

      expect(harness.notified).toEqual([{ jobId: old, runAfter: later }]);
      timer.advance(1_000);
      await harness.deliver(old);
      await expect.poll(() => ran, poll).toEqual(["old"]);
    });

    it("leaves a running job alone", { timeout: 30_000 }, async () => {
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      const old = await jobs.enqueue(
        "conformance.record",
        { label: "old" },
        { idempotencyKey: "turn" },
      );
      const run = harness.deliver(old);
      await expect.poll(() => started, poll).toEqual(["old"]);

      expect(await replace("turn", "new")).toBeUndefined();

      open();
      await run;
      await expect.poll(async () => (await jobs.status(old))?.status, poll).toBe("succeeded");
      expect(ran).toEqual(["old"]);
    });

    it("leaves a job queued again after an attempt", { timeout: 30_000 }, async () => {
      const old = await jobs.enqueue(
        "conformance.fail-once",
        { label: "old" },
        { idempotencyKey: "turn" },
      );
      await harness.deliver(old);
      await expect.poll(async () => (await jobs.status(old))?.attempts, poll).toBe(1);
      expect((await jobs.status(old))?.status).toBe("queued");

      expect(await replace("turn", "new")).toBeUndefined();
      expect((await jobs.status(old))?.status).toBe("queued");
    });

    it("leaves a job a deploy handed back with its Checkpoints", { timeout: 30_000 }, async () => {
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      const deploying = manualExecutor();
      const elsewhere = await runnerOver(deploying.executor);
      const old = await elsewhere.enqueue(
        "conformance.steps",
        { label: "old" },
        { idempotencyKey: "turn" },
      );
      const attempt = deploying.run(old);
      await expect.poll(() => started, poll).toEqual(["old"]);
      // The deploy's stop has the workflow yield at its next Checkpoint.
      const stopping = elsewhere.stop();
      open();
      await stopping;
      await attempt;
      expect(await jobs.status(old)).toMatchObject({ status: "queued", attempts: 0 });

      expect(await replace("turn", "new")).toBeUndefined();
      expect((await jobs.status(old))?.status).toBe("queued");
    });

    it("leaves a job of another name that holds the key", { timeout: 30_000 }, async () => {
      const later = new Date(timer.clock.now().getTime() + 1_000);
      const other = await jobs.enqueue(
        "conformance.hold",
        { label: "other" },
        { idempotencyKey: "turn", runAfter: later },
      );

      expect(await replace("turn", "new")).toBeUndefined();
      expect((await jobs.status(other))?.status).toBe("queued");
    });

    it("queues nothing when no job holds the key", { timeout: 30_000 }, async () => {
      expect(await replace("turn", "new")).toBeUndefined();
      expect(harness.notified).toEqual([]);
    });
  });

  it("fires a recurring schedule once per slot", { timeout: 30_000 }, async () => {
    const first = timer.clock.now().toISOString();
    const second = new Date(timer.clock.now().getTime() + SLOT_MS).toISOString();
    const id = await jobs.enqueue(
      "conformance.recur",
      { slot: first },
      { idempotencyKey: recurKey(first) },
    );

    await Promise.all([harness.deliver(id), harness.deliver(id)]);
    await expect.poll(async () => (await jobs.status(id))?.status, poll).toBe("succeeded");
    expect(fires).toEqual([first]);

    // The next slot's job was queued once, in the fire's transaction, and is due at its slot.
    const next = harness.notified.find(({ jobId }) => jobId !== id);
    expect(next).toEqual({ jobId: expect.any(String), runAfter: new Date(second) });
    await harness.deliver(next!.jobId);
    expect(fires).toEqual([first]);

    timer.advance(SLOT_MS);
    await Promise.all([harness.deliver(next!.jobId), harness.deliver(next!.jobId)]);
    await expect.poll(async () => (await jobs.status(next!.jobId))?.status, poll).toBe("succeeded");
    expect(fires).toEqual([first, second]);
  });
});
