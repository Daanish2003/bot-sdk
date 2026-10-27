import type { Inngest, InngestFunction } from "inngest";

import {
  type CoreRun,
  type Executor,
  type JobBudget,
  jobBudgetKeys,
  jobBudgets,
  sweepJobs,
} from "@botsdk/bot/runner/internal";

/**
 * How long past its due time a delivery that arrives early (its process's clock a little behind the
 * notifier's) waits, so that the core then finds the job due rather than leaving it to the sweep.
 */
const WAKE_MARGIN_MS = 1_000;

/** Within one window, the sweep's events for a job are one event: a second sweep sends none. */
const SWEEP_WINDOW_MS = 60_000;

/** How many events the sweep sends in one request. */
const SEND_BATCH = 100;

export type InngestExecutorOptions = {
  /** The Host's Inngest client. Its functions are served from the Host's `serve()` handler. */
  client: Inngest.Any;
  /** When the sweep runs on its own, as a cron expression. Every 5 minutes by default. */
  sweepCron?: string;
};

export type InngestExecutor = Executor & {
  /**
   * The functions to pass to Inngest's `serve()`, alongside the Host's own. They include one for
   * each concurrency budget of the jobs, so read this after the SDK has started.
   */
  readonly functions: InngestFunction.Any[];
  /**
   * The events the Executor sends and its functions receive, named after the client's app id, so
   * that two apps in one Inngest environment never wake each other's jobs.
   */
  events: {
    /**
     * A job is due at `runAfter` (now when absent): `{ jobId, runAfter?, budget? }`, where `budget`
     * is the key of its concurrency budget, if it has one.
     */
    due: string;
    /** Sweeps now, as the cron does: `{}`. */
    sweep: string;
  };
};

/**
 * The Inngest Executor (ADR 0029, spec #878), for the `runner` slot. Each `notify` sends one `due`
 * event, whose function calls the core's `run` once the job is due (at once when it already is). The core's
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

  const runDue = async ({
    event,
    step,
  }: {
    event: { data: unknown };
    step: { sleepUntil(id: string, until: Date): Promise<unknown> };
  }) => {
    const { jobId, runAfter } = event.data as { jobId: string; runAfter?: string };
    // Due by this process's clock: run now, with no extra round trip. Otherwise sleep until a
    // little past it, which also covers this clock being a little behind the notifier's.
    const due = runAfter === undefined ? undefined : Date.parse(runAfter);
    if (due !== undefined && Date.now() < due) {
      await step.sleepUntil("until-due", new Date(due + WAKE_MARGIN_MS));
    }
    // Claims, replays and runs it; a job that isn't queued and due, or whose lease another
    // delivery holds, is left alone.
    await started()(jobId);
  };

  // Jobs in no budget run at once. A budget's jobs have its key in their event, which only its
  // own function takes, and Inngest runs at most its limit of that function at once.
  const runJob = client.createFunction(
    {
      id: "botsdk-run-job",
      triggers: [{ event: events.due, if: "event.data.budget == null" }],
    },
    runDue,
  );
  let budgetFunctions: InngestFunction.Any[] = [];
  const budgetFunction = ({ key, concurrency }: JobBudget) =>
    client.createFunction(
      {
        id: `botsdk-run-job-${key.replace(/[^a-zA-Z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`,
        triggers: [{ event: events.due, if: `event.data.budget == ${JSON.stringify(key)}` }],
        concurrency: { limit: concurrency },
      },
      runDue,
    );

  /** Which budget each job is in, for the events that wake them. */
  const budgetsOfJobs = async (jobIds: string[]) =>
    jobIds.length === 0 ? new Map<string, string>() : await started()[jobBudgetKeys]!(jobIds);

  const sweep = client.createFunction(
    {
      id: "botsdk-sweep-jobs",
      triggers: [{ cron: sweepCron }, { event: events.sweep }],
      // One sweep at a time, so that two never send the same jobs.
      concurrency: { limit: 1 },
    },
    async () => {
      await started()[sweepJobs]!(async (jobIds) => {
        // Stamped like a notify, so that an early delivery waits for the job to be due.
        const now = new Date();
        const window = Math.floor(now.getTime() / SWEEP_WINDOW_MS);
        for (let i = 0; i < jobIds.length; i += SEND_BATCH) {
          const batch = jobIds.slice(i, i + SEND_BATCH);
          const budgets = await budgetsOfJobs(batch);
          await client.send(
            batch.map((jobId) => ({
              id: `${jobId}@sweep-${window}`,
              name: events.due,
              data: { jobId, runAfter: now.toISOString(), budget: budgets.get(jobId) },
            })),
          );
        }
      });
    },
  );

  return {
    get functions() {
      return [runJob, sweep, ...budgetFunctions];
    },
    events,

    async start(given: CoreRun) {
      if (!given[sweepJobs])
        throw new Error("The Inngest Executor runs only under the core's runner");
      run = given;
      const budgets = given[jobBudgets]?.() ?? [];
      const ids = new Set(budgets.map(({ key }) => key.toLowerCase()));
      if (ids.size < budgets.length) {
        throw new Error("Two concurrency budgets have keys that differ only in case");
      }
      budgetFunctions = budgets.map(budgetFunction);
    },

    async notify(jobId, runAfter) {
      // A wake-up due now is stamped with this process's time, so that an early delivery waits for
      // it. The id makes the same wake-up sent twice one event, while a later one (a re-notify, a
      // retry's new due time) is a new event.
      const dueAt = (runAfter ?? new Date()).toISOString();
      const budget = (await budgetsOfJobs([jobId])).get(jobId);
      await client.send({
        id: `${jobId}@${dueAt}`,
        name: events.due,
        data: { jobId, runAfter: dueAt, budget },
      });
    },

    async stop() {
      run = undefined;
    },
  };
}
