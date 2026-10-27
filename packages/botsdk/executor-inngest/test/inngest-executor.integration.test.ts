import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Inngest } from "inngest";
import { serve } from "inngest/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  defineCoreJob,
  defineJob,
  type Executor,
  jobTable,
  type JobRunner,
  systemClock,
} from "@botsdk/bot/runner/internal";
import {
  crashingRunner,
  executorContract,
  poll,
  testRunners,
} from "@ai-chat/test-support/executor.contract";
import { manualExecutor, recordingNotify } from "@ai-chat/test-support/executors";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { inngestExecutor } from "../src";

/*
 * The Inngest Executor against a real Inngest dev server (spec #878): the Executor conformance
 * suite, then what is Inngest's own. `TEST_INNGEST_URL` is the dev server as this process reaches it
 * (for example `http://127.0.0.1:8288`), and `TEST_INNGEST_CALLBACK_HOST` is this process as the dev
 * server reaches it (`host.docker.internal` by default: Docker Desktop has it, and Docker Engine on
 * Linux needs `--add-host=host.docker.internal:host-gateway` on the dev server's container). Without
 * `TEST_INNGEST_URL` the file is skipped, except in CI, where it fails.
 */

const devServer = process.env.TEST_INNGEST_URL;
const callbackHost = process.env.TEST_INNGEST_CALLBACK_HOST ?? "host.docker.internal";
if (!devServer && process.env.CI) throw new Error("TEST_INNGEST_URL must be set in CI");

describe.skipIf(!devServer)("the Inngest Executor", () => {
  // One app for the file, so that the dev server keeps calling the same endpoint; each test starts
  // and stops a runner over it.
  const client = new Inngest({
    id: `botsdk-test-${crypto.randomUUID()}`,
    isDev: true,
    baseUrl: devServer,
  });
  // The sweep runs only when a test sends its event: a cron sweep mid-test would run jobs a test
  // expects to stay queued.
  const inngest = inngestExecutor({ client, sweepCron: "0 0 1 1 *" });
  /** Each call Inngest made to the core's `run`, with when it ended. */
  const calls: { jobId: string; done: Promise<void>; delivered?: true }[] = [];
  const executor: Executor = {
    ...inngest,
    start: (run) =>
      inngest.start(
        Object.assign((jobId: string) => {
          const done = run(jobId);
          calls.push({ jobId, done });
          return done;
        }, run),
      ),
  };
  let server: Server;
  let handler: ReturnType<typeof serve> | undefined;
  let port = 0;

  /** Registers the Executor's functions as they are now (its budgets' come with a start). */
  const register = async () => {
    handler = serve({
      client,
      functions: inngest.functions,
      serveOrigin: `http://${callbackHost}:${port}`,
      servePath: "/api/inngest",
    });
    const registered = await fetch(`http://127.0.0.1:${port}/api/inngest`, { method: "PUT" });
    expect(registered.ok, await registered.text()).toBe(true);
  };

  beforeAll(async () => {
    server = createServer((request, response) => handler?.(request, response));
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    port = (server.address() as AddressInfo).port;
    await register();
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
  });

  /** Has Inngest run the job now: an event with no id, which is never deduplicated. */
  const deliver = async (jobId: string) => {
    const before = calls.length;
    await client.send({ name: inngest.events.due, data: { jobId } });
    const call = await vi.waitFor(
      () => {
        // Each delivery waits for its own call, never one another delivery has waited for.
        const found = calls
          .slice(before)
          .find((entry) => entry.jobId === jobId && !entry.delivered);
        if (!found) throw new Error(`Inngest hasn't run job ${jobId} yet`);
        found.delivered = true;
        return found;
      },
      { timeout: 10_000, interval: 20 },
    );
    await call.done;
  };

  executorContract("the conformance suite", () => {
    const { executor: recorded, notified } = recordingNotify(executor);
    return { executor: recorded, notified, deliver };
  });

  describe("on Inngest", () => {
    const ran: string[] = [];
    const started: string[] = [];
    let gate: Promise<void> | undefined;
    const limited = (name: string) =>
      defineJob({
        name,
        payload: z.object({ label: z.string() }),
        concurrency: 2,
        run: async ({ label }, ctx) => {
          await ctx.step("record", async () => {
            started.push(label);
            await gate;
            ran.push(label);
          });
        },
      });
    const shared = (name: string) =>
      defineCoreJob({
        name,
        budget: "inngest.shared",
        payload: z.object({ label: z.string() }),
        concurrency: 2,
        run: async ({ label }, ctx) => {
          await ctx.step("record", async () => {
            started.push(label);
            await gate;
            ran.push(label);
          });
        },
      });
    const table = jobTable([
      {
        jobs: [limited("inngest.limited")],
        services: {},
      },
      {
        jobs: [shared("inngest.shared-a"), shared("inngest.shared-b")],
        services: { deps: {} as never },
      },
      {
        jobs: [
          defineJob({
            name: "inngest.record",
            payload: z.object({ label: z.string() }),
            run: async ({ label }, ctx) => {
              await ctx.step("record", async () => {
                started.push(label);
                await gate;
                ran.push(label);
              });
            },
          }),
        ],
        services: {},
      },
    ]);
    const runners = testRunners(() => table);
    let jobs: JobRunner;

    beforeEach(async () => {
      ran.length = 0;
      started.length = 0;
      gate = undefined;
      jobs = await runners.over(executor, systemClock);
    });

    afterEach(() => runners.stopAll());

    /** The calls Inngest made to the core's `run` for job `id`. */
    const callsFor = (id: string) => calls.filter((call) => call.jobId === id);

    /** Holds the jobs' handlers, then lets `seen` of them start and checks no more do. */
    const startedAtMost = async (seen: number) => {
      await expect.poll(() => started.length, { timeout: 10_000 }).toBe(seen);
      // Long enough for Inngest to start another if its limit let it.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(started).toHaveLength(seen);
    };

    it(
      "runs at most a job's concurrency of it at once, the rest as those end",
      { timeout: 30_000 },
      async () => {
        await register();
        let open!: () => void;
        gate = new Promise((resolve) => (open = resolve));
        const ids = await Promise.all(
          ["a", "b", "c", "d"].map((label) => jobs.enqueue("inngest.limited", { label })),
        );

        await startedAtMost(2);
        open();

        await expect.poll(() => ran.length, { timeout: 10_000 }).toBe(4);
        for (const id of ids) {
          await expect.poll(async () => (await jobs.status(id))?.status, poll).toBe("succeeded");
        }
      },
    );

    it("shares one concurrency between the jobs of a budget", { timeout: 30_000 }, async () => {
      await register();
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      await jobs.enqueue("inngest.shared-a", { label: "a1" });
      await jobs.enqueue("inngest.shared-a", { label: "a2" });
      await jobs.enqueue("inngest.shared-b", { label: "b1" });
      await jobs.enqueue("inngest.shared-b", { label: "b2" });

      await startedAtMost(2);
      open();

      await expect.poll(() => ran.length, { timeout: 10_000 }).toBe(4);
    });

    it("runs a job once when its event is sent twice", { timeout: 30_000 }, async () => {
      const runAfter = new Date(Date.now() + 1_000);
      const id = await jobs.enqueue("inngest.record", { label: "a" }, { runAfter });
      // The core sent it once already; this is the same event again.
      await inngest.notify(id, runAfter);

      await expect.poll(async () => (await jobs.status(id))?.status, poll).toBe("succeeded");
      // Long enough for a second delivery of a duplicate, which wakes at the same time.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(ran).toEqual(["a"]);
      expect((await jobs.status(id))?.attempts).toBe(1);
      expect(callsFor(id)).toHaveLength(1);
    });

    it(
      "wakes a job notified again after a delivery that found it not queued yet",
      { timeout: 30_000 },
      async () => {
        let id = "";
        await getTestDb().transaction(async (tx) => {
          id = await jobs.enqueueIn(tx, "inngest.record", { label: "a" });
          // A wake-up that arrives before the job is visible, as from a process a little early.
          await inngest.notify(id);
          await expect.poll(() => callsFor(id).length, poll).toBe(1);
          await callsFor(id)[0]!.done;
        });

        // The core's notify after the commit must not be dropped as a duplicate.
        await expect.poll(() => ran, poll).toEqual(["a"]);
        await expect.poll(async () => (await jobs.status(id))?.status, poll).toBe("succeeded");
      },
    );

    it("waits on Inngest until a job is due, then runs it", { timeout: 30_000 }, async () => {
      const runAfter = new Date(Date.now() + 2_000);
      const id = await jobs.enqueue("inngest.record", { label: "a" }, { runAfter });

      await expect.poll(() => ran, poll).toEqual(["a"]);
      expect(Date.now()).toBeGreaterThanOrEqual(runAfter.getTime());
      await expect.poll(async () => (await jobs.status(id))?.status, poll).toBe("succeeded");
    });

    it("picks up a job whose lease expired at the sweep", { timeout: 30_000 }, async () => {
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      const { runner: elsewhere, run } = await crashingRunner(runners, new Date());
      const id = await elsewhere.enqueue("inngest.record", { label: "a" });
      void run(id);
      await expect.poll(() => started, poll).toEqual(["a"]);
      // It stops without the handler seeing its abort, and leaves its lease to expire.
      await elsewhere.stop();
      gate = undefined;

      await client.send({ name: inngest.events.sweep, data: {} });

      await expect.poll(() => ran, poll).toEqual(["a"]);
      await expect.poll(async () => (await jobs.status(id))?.status, poll).toBe("succeeded");
      open();
    });

    it(
      "runs a due job the Executor was never told of at the sweep",
      { timeout: 30_000 },
      async () => {
        // Queued through a runner whose notify reaches no one.
        const elsewhere = await runners.over(manualExecutor().executor, systemClock);
        const id = await elsewhere.enqueue("inngest.record", { label: "a" });

        await client.send({ name: inngest.events.sweep, data: {} });

        await expect.poll(() => ran, poll).toEqual(["a"]);
        await expect.poll(async () => (await jobs.status(id))?.status, poll).toBe("succeeded");
      },
    );
  });
});
