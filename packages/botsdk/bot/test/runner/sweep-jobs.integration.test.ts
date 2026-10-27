import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type CoreRun,
  defineJob,
  type Executor,
  jobTable,
  sweepJobs,
  systemClock,
} from "../../src/runner/internal";
import { job } from "../../src/storage";
import { crashingRunner, poll, testRunners } from "@ai-chat/test-support/executor.contract";
import { getTestDb } from "@ai-chat/test-support/test-database";

/*
 * The sweep an Executor that doesn't poll calls (Inngest's, spec #878): it re-queues expired leases,
 * prunes finished jobs, and returns the jobs to wake up.
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

/** A runner on an Executor that only keeps the core's `run`, whose sweep the test calls. */
async function sweeper() {
  let run: CoreRun | undefined;
  const executor: Executor = {
    start: async (given) => {
      run = given;
    },
    notify: async () => {},
    stop: async () => {},
  };
  const runner = await runners.over(executor, systemClock);
  return { runner, sweep: () => run![sweepJobs]!() };
}

afterEach(async () => {
  started.length = 0;
  gate = undefined;
  await runners.stopAll();
});

describe("sweepJobs", () => {
  it(
    "returns a job whose lease it re-queued first, even behind a full sweep of older due jobs",
    { timeout: 30_000 },
    async () => {
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      const { runner: elsewhere, run } = await crashingRunner(runners, new Date());
      const crashed = await elsewhere.enqueue("sweep.hold", { label: "crashed" });
      void run(crashed);
      await expect.poll(() => started, poll).toEqual(["crashed"]);
      await elsewhere.stop();
      open();

      const { runner, sweep } = await sweeper();
      const older = new Date(Date.now() - 60 * 60_000);
      for (let i = 0; i < 501; i++) {
        await runner.enqueue("sweep.hold", { label: `old ${i}` }, { runAfter: older });
      }

      const due = await sweep();

      expect(due[0]).toBe(crashed);
      expect(due.filter((id) => id === crashed)).toHaveLength(1);
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
