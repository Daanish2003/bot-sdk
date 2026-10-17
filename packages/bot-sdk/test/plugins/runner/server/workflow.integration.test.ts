import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createBotSdk } from "../../../../core/server/create-chat";
import { job, jobEvent } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { assistant } from "../../../../plugins/assistant/server/plugin";
import { models } from "../../../../plugins/models/server/plugin";
import { defineJob, type JobContext } from "../../../../plugins/runner/server/jobs/define";
import { inProcessRunner } from "../../../../plugins/runner/server/jobs/in-process";
import {
  claimJob,
  reapStaleJobs,
  runClaimedJob,
} from "../../../../plugins/runner/server/jobs/store";
import { runner } from "../../../../plugins/runner/server/plugin";
import { NonDeterminismError } from "../../../../plugins/runner/server/workflow/engine";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { fakeJobClock } from "../../../support/jobs";
import { getTestDb, testDatabaseUrl } from "../../../support/test-database";

const start = new Date("2026-10-14T10:00:00Z");
const silent = { error: () => {} };
let testDeps: TestDeps | undefined;
const jobDeps = () => (testDeps ??= createTestSdk({ db: getTestDb() }));

/*
 * Each test gates one point of one activity. The attempt that reaches it waits there, as a process
 * that crashes there would stop, until the test releases it. The gate opens once, so a resumed
 * attempt passes it.
 */
let holdAt: { name: string; when: "before" | "after" } | undefined;
let reached: Promise<void>;
let onReached: () => void;
let release: () => void;
const effects: string[] = [];

function holdAtPoint(name: string, when: "before" | "after") {
  holdAt = { name, when };
  reached = new Promise((resolve) => {
    onReached = resolve;
  });
}

async function point(name: string, when: "before" | "after") {
  if (holdAt?.name !== name || holdAt.when !== when) return;
  holdAt = undefined;
  onReached();
  await new Promise<void>((resolve) => {
    release = resolve;
  });
}

/** A plain activity: its side effect is pushing its name to `effects`. */
const step = (ctx: JobContext, name: string) =>
  ctx.activity(name, async () => {
    await point(name, "before");
    effects.push(name);
    await point(name, "after");
    return name.toUpperCase();
  });

// Test-only workflows.
let results: string[][] = [];
let throwOnce: string | undefined;
let failed: unknown[] = [];

defineJob({
  name: "workflow.steps",
  payload: z.object({}),
  run: async (_payload, ctx) => {
    const done: string[] = [];
    for (const name of ["a", "b", "c"]) {
      done.push(
        await ctx.activity(name, async () => {
          await point(name, "before");
          effects.push(name);
          if (throwOnce === name) {
            throwOnce = undefined;
            throw new Error(`${name} failed`);
          }
          await point(name, "after");
          return name.toUpperCase();
        }),
      );
    }
    results.push(done);
  },
  onFailed: (_payload, error) => {
    failed.push(error);
  },
});

/** Written by `workflow.write` in its activity's transaction. */
const MARKER = "workflow.marker";

defineJob({
  name: "workflow.write",
  payload: z.object({}),
  run: async (_payload, ctx) => {
    await ctx.activity("write", async (tx) => {
      await tx.insert(job).values({
        id: uuidv7(start.getTime()),
        name: MARKER,
        payload: {},
        status: "succeeded",
      });
      await point("write", "after");
      return "written";
    });
  },
});

/** Which code `workflow.changing` runs: a deploy changes it while a run is in flight. */
let version = 1;
let patchedSeen: boolean[] = [];

defineJob({
  name: "workflow.changing",
  payload: z.object({}),
  run: async (_payload, ctx) => {
    if (version === 4) {
      // Code that swallows the error a replay throws.
      try {
        await step(ctx, "x");
      } catch {}
      // Carries on as if nothing happened, and replays the recorded `a`.
      await step(ctx, "a");
      return;
    }
    if (version === 3) await step(ctx, "x");
    await step(ctx, "a");
    if (version === 2 && (await ctx.patched("use-b2"))) {
      patchedSeen.push(true);
      await step(ctx, "b2");
    } else {
      if (version === 2) patchedSeen.push(false);
      await step(ctx, "b");
    }
    // Version 5 drops `c`.
    if (version === 5) return;
    await step(ctx, "c");
    if (version === 1) await step(ctx, "d");
  },
  onFailed: (_payload, error) => {
    failed.push(error);
  },
});

defineJob({
  name: "workflow.parallel",
  payload: z.object({}),
  run: async (_payload, ctx) => {
    await Promise.all([step(ctx, "a"), step(ctx, "b")]);
  },
});

defineJob({
  name: "workflow.catches",
  payload: z.object({}),
  run: async (_payload, ctx) => {
    // Code that swallows whatever its activity throws, then still has work before it returns.
    try {
      await step(ctx, "a");
    } catch {}
    await point("caught", "before");
  },
});

let values: { now: number; random: number; patched: boolean }[] = [];

defineJob({
  name: "workflow.values",
  payload: z.object({}),
  run: async (_payload, ctx) => {
    const now = (await ctx.now()).getTime();
    const random = await ctx.random();
    const patched = await ctx.patched("v2");
    values.push({ now, random, patched });
    await step(ctx, "a");
  },
});

beforeEach(() => {
  holdAt = undefined;
  effects.length = 0;
  results = [];
  throwOnce = undefined;
  failed = [];
  version = 1;
  patchedSeen = [];
  values = [];
});

const db = () => getTestDb();

async function enqueue(name: string) {
  const timer = fakeJobClock(start);
  const runner = inProcessRunner({ db: db(), logger: silent, deps: jobDeps, clock: timer.clock });
  const id = await runner.enqueue(name, {});
  return { timer, id };
}

/** Claims the job and runs one attempt of it, without waiting for the attempt to end. */
async function attempt(timer: ReturnType<typeof fakeJobClock>) {
  const claimed = await claimJob(db(), timer.clock.now(), { respectRunAfter: false });
  if (!claimed) throw new Error("Nothing to claim");
  return runClaimedJob(db(), claimed, { clock: timer.clock, logger: silent, deps: jobDeps });
}

/** The process running the job stops: its lease expires and the reaper re-queues the job. */
async function crash(timer: ReturnType<typeof fakeJobClock>) {
  timer.advance(61_000);
  await reapStaleJobs(db(), timer.clock.now(), silent, jobDeps());
}

/** The job's history as `"<seq> <kind> <name>"` lines, with each result. */
async function historyOf(jobId: string) {
  const rows = await db()
    .select()
    .from(jobEvent)
    .where(eq(jobEvent.jobId, jobId))
    .orderBy(asc(jobEvent.seq));
  return rows.map((row) => ({ seq: row.seq, kind: row.kind, name: row.name, result: row.result }));
}

async function jobOf(id: string) {
  const [row] = await db().select().from(job).where(eq(job.id, id));
  return row;
}

const markers = async () => db().select().from(job).where(eq(job.name, MARKER));

describe("a workflow's history", () => {
  it("records each finished activity as a Checkpoint, in call order", async () => {
    const { timer, id } = await enqueue("workflow.steps");

    await attempt(timer);

    expect(results).toEqual([["A", "B", "C"]]);
    expect(await historyOf(id)).toEqual([
      { seq: 1, kind: "activity", name: "a", result: "A" },
      { seq: 2, kind: "activity", name: "b", result: "B" },
      { seq: 3, kind: "activity", name: "c", result: "C" },
    ]);
    expect(await jobOf(id)).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("killed after activity N, resumes by skipping 1..N and running N+1", async () => {
    const { timer, id } = await enqueue("workflow.steps");
    holdAtPoint("c", "before");
    const lost = attempt(timer);
    await reached;

    await crash(timer);
    await attempt(timer);

    expect(effects).toEqual(["a", "b", "c"]);
    expect(results).toEqual([["A", "B", "C"]]);
    expect((await historyOf(id)).map((entry) => entry.name)).toEqual(["a", "b", "c"]);
    expect(await jobOf(id)).toMatchObject({ status: "succeeded", attempts: 2 });
    release();
    await lost;
  });

  it("killed between a plain activity's side effect and its Checkpoint, runs the side effect twice", async () => {
    const { timer, id } = await enqueue("workflow.steps");
    holdAtPoint("b", "after");
    const lost = attempt(timer);
    await reached;

    await crash(timer);
    await attempt(timer);

    expect(effects).toEqual(["a", "b", "b", "c"]);
    expect((await historyOf(id)).map((entry) => entry.name)).toEqual(["a", "b", "c"]);
    release();
    await lost;
  });

  it("killed inside a (tx) activity before commit, loses the write, and the retry writes it once", async () => {
    const { timer, id } = await enqueue("workflow.write");
    holdAtPoint("write", "after");
    const lost = attempt(timer);
    await reached;
    expect(await markers()).toHaveLength(0);

    await crash(timer);
    await attempt(timer);
    expect(await markers()).toHaveLength(1);

    // The lost attempt's transaction can't commit: its fence rolls the write back.
    release();
    await lost;
    expect(await markers()).toHaveLength(1);
    expect(await historyOf(id)).toEqual([
      { seq: 1, kind: "activity", name: "write", result: "written" },
    ]);
    expect(await jobOf(id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("fences a lost attempt's activity write, which adds no history entry and stops the attempt", async () => {
    const { timer, id } = await enqueue("workflow.steps");
    holdAtPoint("b", "after");
    const lost = attempt(timer);
    await reached;
    await crash(timer);
    // Another process claims the job, so the first attempt no longer owns it.
    const claimed = await claimJob(db(), timer.clock.now());
    expect(claimed).toMatchObject({ attempts: 2 });

    release();
    await lost;

    expect(await historyOf(id)).toEqual([{ seq: 1, kind: "activity", name: "a", result: "A" }]);
    // The lost attempt stopped at its fenced write: `c` never ran.
    expect(effects).toEqual(["a", "b"]);
    expect(await jobOf(id)).toMatchObject({ status: "running", attempts: 2 });
  });

  it("shares one history between two runners on one database, with no seq written twice", async () => {
    const timer = fakeJobClock(start);
    const runners = [1, 2].map(() =>
      inProcessRunner({ db: db(), logger: silent, deps: jobDeps, clock: timer.clock, drainMs: 20 }),
    );
    holdAtPoint("b", "after");
    const id = await runners[0]!.enqueue("workflow.steps", {});
    await runners[0]!.start();
    await reached;
    await crash(timer);

    await runners[1]!.start();
    await expect.poll(async () => (await jobOf(id))?.status).toBe("succeeded");
    release();
    for (const runner of runners) await runner.stop();

    expect(await historyOf(id)).toEqual([
      { seq: 1, kind: "activity", name: "a", result: "A" },
      { seq: 2, kind: "activity", name: "b", result: "B" },
      { seq: 3, kind: "activity", name: "c", result: "C" },
    ]);
    expect(results).toEqual([["A", "B", "C"]]);
    expect(await jobOf(id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("fails the job with a NonDeterminismError naming the seq when the call order changed, and runs onFailed", async () => {
    const { timer, id } = await enqueue("workflow.changing");
    holdAtPoint("b", "before");
    const lost = attempt(timer);
    await reached;
    await crash(timer);

    // A deploy puts a new activity first.
    version = 3;
    await attempt(timer);

    const row = await jobOf(id);
    expect(row).toMatchObject({ status: "failed", attempts: 2 });
    expect(row?.lastError).toMatch(/seq 1/);
    expect(row?.lastError).toMatch(/activity "a"/);
    expect(row?.lastError).toMatch(/activity "x"/);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBeInstanceOf(NonDeterminismError);
    expect(effects).toEqual(["a"]);
    release();
    await lost;
  });

  it("fails the job with a NonDeterminismError even when the workflow's code catches it", async () => {
    const { timer, id } = await enqueue("workflow.changing");
    holdAtPoint("b", "before");
    const lost = attempt(timer);
    await reached;
    await crash(timer);

    version = 4;
    await attempt(timer);

    expect(await jobOf(id)).toMatchObject({ status: "failed", attempts: 2 });
    expect(failed[0]).toBeInstanceOf(NonDeterminismError);
    release();
    await lost;
  });

  it("fails the job with a NonDeterminismError when the code ends before its recorded calls", async () => {
    const { timer, id } = await enqueue("workflow.changing");
    holdAtPoint("d", "before");
    const lost = attempt(timer);
    await reached;
    await crash(timer);

    // A deploy drops `c`, which the history recorded at seq 3.
    version = 5;
    await attempt(timer);

    const row = await jobOf(id);
    expect(row).toMatchObject({ status: "failed", attempts: 2 });
    expect(row?.lastError).toMatch(/seq 3.*activity "c"/);
    expect(failed[0]).toBeInstanceOf(NonDeterminismError);
    release();
    await lost;
  });

  it("refuses a call made while another is still pending, since call order is identity", async () => {
    const { timer, id } = await enqueue("workflow.parallel");

    await attempt(timer);

    expect((await jobOf(id))?.lastError).toMatch(/one at a time/);
    expect(effects).toEqual(["a"]);
  });

  it("replays ctx.now(), ctx.random() and ctx.patched() with the values they first returned", async () => {
    const { timer } = await enqueue("workflow.values");
    holdAtPoint("a", "before");
    const lost = attempt(timer);
    await reached;

    await crash(timer);
    await attempt(timer);

    expect(values).toHaveLength(2);
    expect(values[0]).toEqual({ now: start.getTime(), random: expect.any(Number), patched: true });
    expect(values[1]).toEqual(values[0]);
    release();
    await lost;
  });

  it("gives ctx.patched() false on a history recorded before the patch", async () => {
    const { timer } = await enqueue("workflow.changing");
    holdAtPoint("c", "before");
    const lost = attempt(timer);
    await reached;
    await crash(timer);

    // A deploy patches `b` into `b2`; the run started before it keeps taking `b`.
    version = 2;
    await attempt(timer);

    expect(patchedSeen).toEqual([false]);
    expect(effects).toEqual(["a", "b", "c"]);
    release();
    await lost;

    // A run started after the deploy takes the patched path.
    await enqueue("workflow.changing");
    await attempt(timer);
    expect(patchedSeen).toEqual([false, true]);
  });

  it("records nothing for a thrown activity, and the retry resumes after the last Checkpoint", async () => {
    const { timer, id } = await enqueue("workflow.steps");
    throwOnce = "b";

    await attempt(timer);
    expect(await jobOf(id)).toMatchObject({ status: "queued", attempts: 1, lastError: "b failed" });
    expect(await historyOf(id)).toEqual([{ seq: 1, kind: "activity", name: "a", result: "A" }]);

    await attempt(timer);

    expect(effects).toEqual(["a", "b", "b", "c"]);
    expect(results).toEqual([["A", "B", "C"]]);
    expect(await jobOf(id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("is removed with its job", async () => {
    const { timer, id } = await enqueue("workflow.steps");
    await attempt(timer);

    await db().delete(job).where(eq(job.id, id));

    expect(await historyOf(id)).toEqual([]);
  });
});

describe("a deploy or a cancel", () => {
  const runnerWith = (timer: ReturnType<typeof fakeJobClock>, drainMs: number) =>
    inProcessRunner({ db: db(), logger: silent, deps: jobDeps, clock: timer.clock, drainMs });

  it("stop() hands the job back at its next Checkpoint, uncounted, and another runner finishes it", async () => {
    const timer = fakeJobClock(start);
    const deploying = runnerWith(timer, 2_000);
    holdAtPoint("b", "before");
    const id = await deploying.enqueue("workflow.steps", {});
    await deploying.start();
    await reached;

    const stopping = deploying.stop();
    release();
    await stopping;

    // `b` saved its Checkpoint, then the workflow yielded before `c`.
    expect(effects).toEqual(["a", "b"]);
    expect((await historyOf(id)).map((entry) => entry.name)).toEqual(["a", "b"]);
    const handedBack = await jobOf(id);
    expect(handedBack).toMatchObject({ status: "queued", attempts: 0 });
    expect(handedBack?.runAfter.getTime()).toBe(start.getTime());

    // Another process resumes it at once, with no lease to wait out.
    const next = runnerWith(timer, 20);
    await next.start();
    await expect.poll(async () => (await jobOf(id))?.status).toBe("succeeded");
    await next.stop();

    expect(effects).toEqual(["a", "b", "c"]);
    expect(results).toEqual([["A", "B", "C"]]);
    expect(await jobOf(id)).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("stop() aborts a job still running after drainMs, as before, and leaves its lease", async () => {
    const timer = fakeJobClock(start);
    const deploying = runnerWith(timer, 20);
    holdAtPoint("b", "before");
    const id = await deploying.enqueue("workflow.steps", {});
    await deploying.start();
    await reached;

    await deploying.stop();

    expect(await jobOf(id)).toMatchObject({ status: "running", attempts: 1 });
    expect((await historyOf(id)).map((entry) => entry.name)).toEqual(["a"]);
    release();
  });

  it("a cancel stops a running job at its next Checkpoint, and nothing is recorded after it", async () => {
    const timer = fakeJobClock(start);
    const jobs = runnerWith(timer, 20);
    holdAtPoint("b", "after");
    const id = await jobs.enqueue("workflow.steps", {}, { idempotencyKey: "k" });
    await jobs.start();
    await reached;

    await jobs.cancel("k");
    release();

    await expect.poll(async () => (await jobOf(id))?.status).toBe("cancelled");
    await jobs.stop();
    // `b`'s Checkpoint was fenced, so `c` never ran.
    expect(effects).toEqual(["a", "b"]);
    expect(await historyOf(id)).toEqual([{ seq: 1, kind: "activity", name: "a", result: "A" }]);
    expect(await jobOf(id)).toMatchObject({ status: "cancelled", attempts: 1 });
  });

  it("a cancel rolls back a (tx) activity's write at its fence", async () => {
    const timer = fakeJobClock(start);
    const jobs = runnerWith(timer, 2_000);
    holdAtPoint("write", "after");
    const id = await jobs.enqueue("workflow.write", {}, { idempotencyKey: "k" });
    await jobs.start();
    await reached;

    await jobs.cancel("k");
    release();
    await jobs.stop();

    expect(await markers()).toHaveLength(0);
    expect(await historyOf(id)).toEqual([]);
    expect(await jobOf(id)).toMatchObject({ status: "cancelled", attempts: 1 });
  });

  it("fences the hand-back: an attempt that lost its lease can't hand the row back", async () => {
    const timer = fakeJobClock(start);
    const deploying = runnerWith(timer, 2_000);
    holdAtPoint("a", "before");
    const id = await deploying.enqueue("workflow.catches", {});
    await deploying.start();
    await reached;

    const stopping = deploying.stop();
    // `a` saves and yields; the code swallows that and holds on.
    holdAtPoint("caught", "before");
    release();
    await reached;
    // Meanwhile its lease expires and another process claims the job.
    await crash(timer);
    expect(await claimJob(db(), timer.clock.now())).toMatchObject({ attempts: 2 });

    release();
    await stopping;

    expect(await jobOf(id)).toMatchObject({ status: "running", attempts: 2 });
  });
});

describe("runJob (a Host's worker)", () => {
  it("records nothing: every workflow call runs for real", async () => {
    const chat = createBotSdk({
      databaseUrl: testDatabaseUrl,
      getUser: () => null,
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      basePath: "/api/chat",
      logger: silent,
      plugins: [models(), runner(), assistant()],
    });

    await chat.plugin("runner").runJob("workflow.write", {});
    await chat.plugin("runner").runJob("workflow.steps", {});

    expect(await markers()).toHaveLength(1);
    expect(effects).toEqual(["a", "b", "c"]);
    expect(await db().select().from(jobEvent)).toEqual([]);
  });
});

describe("the workflow engine", () => {
  it("imports nothing from the Bot SDK", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../../../plugins/runner/server/workflow/engine.ts", import.meta.url),
      ),
      "utf8",
    );

    expect(source).not.toMatch(/\bimport\b|\bfrom\s+["']|\brequire\(/);
  });
});
