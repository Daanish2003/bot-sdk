import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { uuidv7 } from "../../src/lib/uuidv7";
import { defineJob, jobTable, systemClock } from "../../src/runner/internal";
import { job } from "../../src/storage";
import { crashingRunner, poll, testRunners } from "@ai-chat/test-support/executor.contract";
import { manualExecutor } from "@ai-chat/test-support/executors";
import { getTestDb } from "@ai-chat/test-support/test-database";

/*
 * The sweep an Executor that doesn't poll calls (Inngest's, spec #878): it re-queues expired leases,
 * wakes the due jobs, and prunes finished jobs.
 */

const started: string[] = [];
let gate: Promise<void> | undefined;
const table = jobTable([
  {
    jobs: [
      defineJob({
        name: "sweep.hold",
        payload: z.object({ label: z.string() }),
        run: async ({ label }) => {
          started.push(label);
          await gate;
        },
      }),
    ],
    services: {},
  },
]);
const runners = testRunners(() => table);

/** A runner on a manual Executor, whose sweep the test calls. */
async function sweeper() {
  const manual = manualExecutor();
  const runner = await runners.over(manual.executor, systemClock);
  return { runner, sweep: manual.sweep };
}

/** Queues a job whose lease expired in a crashed process, and returns its id. */
async function crashedJob() {
  let open!: () => void;
  gate = new Promise((resolve) => (open = resolve));
  const { runner, run } = await crashingRunner(runners, new Date());
  const id = await runner.enqueue("sweep.hold", { label: "crashed" });
  void run(id);
  await expect.poll(() => started, poll).toEqual(["crashed"]);
  await runner.stop();
  open();
  return id;
}

afterEach(async () => {
  started.length = 0;
  gate = undefined;
  await runners.stopAll();
});

describe("sweepJobs", () => {
  it("wakes a job whose lease it re-queued, once", { timeout: 30_000 }, async () => {
    const crashed = await crashedJob();
    const { sweep } = await sweeper();

    expect(await sweep()).toEqual([crashed]);
  });

  it(
    "wakes a job whose lease it re-queued first, even behind a full sweep of older due jobs",
    { timeout: 30_000 },
    async () => {
      const crashed = await crashedJob();
      const { sweep } = await sweeper();
      const older = new Date(Date.now() - 60 * 60_000);
      await getTestDb()
        .insert(job)
        .values(
          Array.from({ length: 501 }, (_, i) => ({
            id: uuidv7(older.getTime()),
            name: "sweep.hold",
            payload: { label: `old ${i}` },
            runAfter: older,
            createdAt: older,
            updatedAt: older,
          })),
        );

      const woken = await sweep();

      expect(woken[0]).toBe(crashed);
      expect(woken.filter((id) => id === crashed)).toHaveLength(1);
    },
  );

  it("prunes finished jobs past their retention", { timeout: 30_000 }, async () => {
    const { runner, sweep } = await sweeper();
    const id = await runner.enqueue("sweep.hold", { label: "done" });
    await getTestDb()
      .update(job)
      .set({ status: "succeeded", updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })
      .where(eq(job.id, id));

    await sweep();

    expect(await runner.status(id)).toBeUndefined();
  });
});
