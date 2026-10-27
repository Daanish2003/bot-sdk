import type { Inngest, InngestFunction } from "inngest";

import { type CoreRun, type Executor, sweepJobs } from "@botsdk/bot/runner/internal";

/**
 * How long past `runAfter` the function wakes, so that a clock a little behind Inngest's still finds
 * the job due (otherwise it would wait for the next sweep).
 */
const WAKE_MARGIN_MS = 1_000;

export type InngestExecutorOptions = {
  /** The Host's Inngest client. Its functions are served from the Host's `serve()` handler. */
  client: Inngest.Any;
  /** When the sweep runs on its own, as a cron expression. Every 5 minutes by default. */
  sweepCron?: string;
};

export type InngestExecutor = Executor & {
  /** The functions to pass to Inngest's `serve()`, alongside the Host's own. */
  functions: InngestFunction.Any[];
  /**
   * The events the Executor sends and its functions receive, named after the client's app id, so
   * that two apps in one Inngest environment never wake each other's jobs.
   */
  events: {
    /** A job is due at `runAfter` (now when absent): `{ jobId, runAfter? }`. */
    due: string;
    /** Sweeps now, as the cron does: `{}`. */
    sweep: string;
  };
};

/**
 * The Inngest Executor (ADR 0029, spec #878), for the `runner` slot. Each `notify` sends one `due`
 * event, whose function sleeps until the job is due and then calls the core's `run`. The core's
 * leases and fencing keep each job exactly-once, so a duplicate delivery is harmless. A cron sweep
 * (or a `sweep` event) re-queues the jobs whose lease expired and sends an event for each due job,
 * so a lost event never strands one. The Host mounts `functions` with Inngest's `serve()` in a
 * process where the SDK has started.
 */
export function inngestExecutor({
  client,
  sweepCron = "*/5 * * * *",
}: InngestExecutorOptions): InngestExecutor {
  let run: CoreRun | undefined;
  const events = { due: `${client.id}/botsdk.job.due`, sweep: `${client.id}/botsdk.jobs.sweep` };

  /** The core's `run`, or a retriable error, so that Inngest redelivers to a started process. */
  const started = () => {
    if (!run) throw new Error("The Bot SDK hasn't started in this process; Inngest retries");
    return run;
  };

  const runJob = client.createFunction(
    { id: "botsdk-run-job", triggers: [{ event: events.due }] },
    async ({ event, step }) => {
      const { jobId, runAfter } = event.data as { jobId: string; runAfter?: string };
      // Returns at once when that time has passed.
      if (runAfter) {
        await step.sleepUntil("until-due", new Date(Date.parse(runAfter) + WAKE_MARGIN_MS));
      }
      // Claims, replays and runs it; a job that isn't queued and due, or whose lease another
      // delivery holds, is left alone.
      await started()(jobId);
    },
  );

  const sweep = client.createFunction(
    { id: "botsdk-sweep-jobs", triggers: [{ cron: sweepCron }, { event: events.sweep }] },
    async () => {
      const due = await started()[sweepJobs]!();
      if (due.length === 0) return;
      await client.send(due.map((jobId) => ({ name: events.due, data: { jobId } })));
    },
  );

  return {
    functions: [runJob, sweep],
    events,

    async start(given: CoreRun) {
      if (!given[sweepJobs])
        throw new Error("The Inngest Executor runs only under the core's runner");
      run = given;
    },

    async notify(jobId, runAfter) {
      // The id makes a repeated send of the same wake-up a no-op; a retry's is due at a new time.
      await client.send({
        id: runAfter ? `${jobId}@${runAfter.toISOString()}` : jobId,
        name: events.due,
        data: { jobId, ...(runAfter && { runAfter: runAfter.toISOString() }) },
      });
    },

    async stop() {
      run = undefined;
    },
  };
}
