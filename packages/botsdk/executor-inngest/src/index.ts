import type { Inngest, InngestFunction } from "inngest";

import { type CoreRun, type Executor, sweepJobs } from "@botsdk/bot/runner/internal";

/** The events the Executor sends and its functions receive. */
export const inngestEvents = {
  /** A job is due at `runAfter` (now when absent): `{ jobId, runAfter? }`. */
  due: "botsdk/job.due",
  /** Sweeps now, as the cron does: re-queues expired leases and sends `due` for each due job. */
  sweep: "botsdk/jobs.sweep",
} as const;

/** How often the sweep runs on its own. */
const SWEEP_CRON = "*/5 * * * *";

export type InngestExecutorOptions = {
  /** The Host's Inngest client. Its functions are served from the Host's `serve()` handler. */
  client: Inngest.Any;
};

export type InngestExecutor = Executor & {
  /** The functions to pass to Inngest's `serve()`, alongside the Host's own. */
  functions: InngestFunction.Any[];
};

/**
 * The Inngest Executor (ADR 0029, spec #878), for the `runner` slot. Each `notify` sends one
 * `botsdk/job.due` event, whose function sleeps until the job is due and then calls the core's
 * `run`. The core's leases and fencing keep each job exactly-once, so a duplicate delivery is
 * harmless. A cron sweep every 5 minutes (or a `botsdk/jobs.sweep` event) re-queues the jobs whose
 * lease expired and sends an event for each due job, so a lost event never strands one. The Host
 * mounts `functions` with Inngest's `serve()` in a process where the SDK has started.
 */
export function inngestExecutor({ client }: InngestExecutorOptions): InngestExecutor {
  let run: CoreRun | undefined;

  /** The core's `run`, or a retriable error, so that Inngest redelivers to a started process. */
  const started = () => {
    if (!run) throw new Error("The Bot SDK hasn't started in this process; Inngest retries");
    return run;
  };

  const runJob = client.createFunction(
    { id: "botsdk-run-job", triggers: [{ event: inngestEvents.due }] },
    async ({ event, step }) => {
      const { jobId, runAfter } = event.data as { jobId: string; runAfter?: string };
      if (runAfter && new Date(runAfter).getTime() > Date.now()) {
        await step.sleepUntil("until-due", runAfter);
      }
      // Claims, replays and runs it; a job that isn't queued and due, or whose lease another
      // delivery holds, is left alone.
      await started()(jobId);
    },
  );

  const sweep = client.createFunction(
    { id: "botsdk-sweep-jobs", triggers: [{ cron: SWEEP_CRON }, { event: inngestEvents.sweep }] },
    async () => {
      const due = await started()[sweepJobs]!();
      if (due.length === 0) return;
      await client.send(due.map((jobId) => ({ name: inngestEvents.due, data: { jobId } })));
    },
  );

  return {
    functions: [runJob, sweep],

    async start(given: CoreRun) {
      if (!given[sweepJobs])
        throw new Error("The Inngest Executor runs only under the core's runner");
      run = given;
    },

    async notify(jobId, runAfter) {
      // The id makes a repeated send of the same wake-up a no-op; a retry's is due at a new time.
      await client.send({
        id: runAfter ? `${jobId}@${runAfter.toISOString()}` : jobId,
        name: inngestEvents.due,
        data: { jobId, ...(runAfter && { runAfter: runAfter.toISOString() }) },
      });
    },

    async stop() {
      run = undefined;
    },
  };
}
