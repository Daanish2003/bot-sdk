import { and, asc, eq, sql } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  defineFeature,
  defineJob,
  type BotSdkOptions,
  type Database,
} from "../../../core/server/index";
import { buildBotSdk, type BotSdk } from "../../../core/server/create-chat";
import { createDb, job, jobEvent } from "../../../core/server/storage";
import { getTestDb, testDatabaseUrl } from "../../support/test-database";
import { postgres } from "../../../core/server/database";

/*
 * The public `defineJob` (spec #872): a Host registers its own jobs through the factory's `jobs`
 * option, and they run on the SDK's runner with durable steps, a transactional step included.
 */

const poll = { timeout: 10_000 };
const note = pgSchema("chat").table("test_host_note", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
});

const noteJob = defineJob({
  name: "host.note",
  payload: z.object({ id: z.string(), text: z.string() }),
  run: async ({ id, text: body }, ctx) => {
    expectTypeOf(ctx.db).toEqualTypeOf<Database>();
    // Its write commits with its Checkpoint, or not at all.
    await ctx.step("write", (tx) => tx.insert(note).values({ id, text: body }));
  },
});

/** Released by the test that queues `host.slow` jobs; until then each one keeps running. */
let slowGate: Promise<void> | undefined;
const slowStarted: string[] = [];
const slowJob = defineJob({
  name: "host.slow",
  payload: z.object({ label: z.string() }),
  concurrency: 1,
  run: async ({ label }) => {
    slowStarted.push(label);
    await slowGate;
  },
});

const unlisted = defineJob({ name: "host.unlisted", payload: z.object({}), run: async () => {} });

const instances: BotSdk[] = [];

function hostSdk(options: Partial<BotSdkOptions> = {}): BotSdk {
  const { instance } = buildBotSdk(
    {
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      logger: { error: () => {} },
      models: {},
      jobs: [noteJob, slowJob],
      ...options,
    },
    { db: getTestDb() },
  );
  instances.push(instance);
  return instance;
}

const statusOf = async (sdk: BotSdk, id: string) => (await sdk.runner.status(id))?.status;
const notes = async () =>
  (await getTestDb().select().from(note).orderBy(asc(note.id))).map((row) => row.id);

beforeAll(async () => {
  await getTestDb().execute(
    sql`create table if not exists chat.test_host_note (id text primary key, text text not null)`,
  );
});

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop();
  await getTestDb().delete(note);
  await getTestDb()
    .delete(job)
    .where(sql`${job.name} like 'host.%'`);
  slowStarted.length = 0;
  slowGate = undefined;
});

afterAll(async () => {
  await getTestDb().execute(sql`drop table if exists chat.test_host_note`);
});

describe("a Host job registered through the factory", () => {
  it(
    "runs, and its transactional step commits with its Checkpoint",
    { timeout: 30_000 },
    async () => {
      const sdk = hostSdk();
      await sdk.start();

      const id = await sdk.runner.enqueue("host.note", { id: "a", text: "hello" });

      await expect.poll(() => statusOf(sdk, id), poll).toBe("succeeded");
      expect(await notes()).toEqual(["a"]);
      const history = await getTestDb()
        .select({ kind: jobEvent.kind, name: jobEvent.name })
        .from(jobEvent)
        .where(eq(jobEvent.jobId, id));
      expect(history).toEqual([{ kind: "activity", name: "write" }]);
    },
  );

  it(
    "is queued in the Host's transaction, and only if it commits",
    { timeout: 30_000 },
    async () => {
      const sdk = hostSdk();
      await sdk.start();

      const committed = await getTestDb().transaction((tx) =>
        sdk.runner.enqueueIn(tx, "host.note", { id: "kept", text: "x" }),
      );
      let rolledBack: string | undefined;
      await getTestDb()
        .transaction(async (tx) => {
          rolledBack = await sdk.runner.enqueueIn(tx, "host.note", { id: "dropped", text: "x" });
          throw new Error("The Host's write failed");
        })
        .catch(() => {});

      await expect.poll(() => statusOf(sdk, committed), poll).toBe("succeeded");
      expect(await statusOf(sdk, rolledBack!)).toBeUndefined();
      expect(await notes()).toEqual(["kept"]);
    },
  );

  it(
    "is queued in a transaction of the Host's own Drizzle instance, runs after commit, and never after a rollback",
    { timeout: 30_000 },
    async () => {
      const sdk = hostSdk();
      await sdk.start();
      // Another pool on the same database: its transactions aren't the SDK's, so nothing notifies
      // the Executor and the in-process poll picks the job up.
      const hostDb = createDb({ DATABASE_URL: testDatabaseUrl });
      try {
        const committed = await hostDb.transaction((tx) =>
          sdk.runner.enqueueIn(tx, "host.note", { id: "own", text: "x" }),
        );
        let rolledBack: string | undefined;
        await hostDb
          .transaction(async (tx) => {
            rolledBack = await sdk.runner.enqueueIn(tx, "host.note", { id: "undone", text: "x" });
            throw new Error("The Host's write failed");
          })
          .catch(() => {});

        await expect.poll(() => statusOf(sdk, committed), poll).toBe("succeeded");
        expect(rolledBack).toBeDefined();
        expect(await statusOf(sdk, rolledBack!)).toBeUndefined();
        expect(await notes()).toEqual(["own"]);
      } finally {
        await hostDb.$client.end();
      }
    },
  );

  it("is cancelled in the Host's transaction before it runs", { timeout: 30_000 }, async () => {
    const sdk = hostSdk();
    await sdk.start();
    const later = new Date(Date.now() + 60 * 60_000);
    const id = await sdk.runner.enqueue(
      "host.note",
      { id: "later", text: "x" },
      { idempotencyKey: "host-note:later", runAfter: later },
    );

    const cancelled = await getTestDb().transaction((tx) =>
      sdk.runner.cancelIn(tx, "host-note:later"),
    );

    expect(cancelled).toBe("queued");
    expect(await statusOf(sdk, id)).toBe("cancelled");
  });

  it(
    "runs no more at once than its concurrency on the in-process Executor",
    { timeout: 30_000 },
    async () => {
      let release!: () => void;
      slowGate = new Promise((resolve) => {
        release = resolve;
      });
      const sdk = hostSdk();
      await sdk.start();

      const ids = await Promise.all(
        ["a", "b", "c"].map((label) => sdk.runner.enqueue("host.slow", { label })),
      );
      await expect.poll(() => slowStarted, poll).toHaveLength(1);
      // A job with a budget of its own leaves the shared one free.
      const other = await sdk.runner.enqueue("host.note", { id: "beside", text: "x" });
      await expect.poll(() => statusOf(sdk, other), poll).toBe("succeeded");
      expect(slowStarted).toHaveLength(1);

      release();
      for (const id of ids) await expect.poll(() => statusOf(sdk, id), poll).toBe("succeeded");
      expect([...slowStarted].sort()).toEqual(["a", "b", "c"]);
    },
  );

  it("is the only way a job is known: a defined job no instance lists can't be queued", async () => {
    const sdk = hostSdk();

    await expect(sdk.runner.enqueue(unlisted.name, {})).rejects.toThrow(
      'No job named "host.unlisted" is defined',
    );
  });

  it("throws at construction when two jobs share a name", () => {
    const feature = defineFeature({ id: "notes", jobs: [noteJob] });

    expect(() => hostSdk({ features: [feature] })).toThrow(
      'A job named "host.note" is defined twice',
    );
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "throws at construction for a concurrency of %s, which would never run",
    (concurrency) => {
      const stuck = defineJob({ ...unlisted, name: "host.stuck", concurrency });

      expect(() => hostSdk({ jobs: [stuck] })).toThrow(
        `The job "host.stuck" has a concurrency of ${concurrency}: it must be a whole number above 0`,
      );
    },
  );
});

describe("a feature's job", () => {
  it("gets the core services its feature needs in its context", { timeout: 30_000 }, async () => {
    const seen: string[] = [];
    const featureJob = defineJob({
      name: "host.feature-job",
      payload: z.object({}),
      run: async (_payload, ctx) => {
        seen.push(typeof ctx.db.select, typeof ctx.jobs.enqueueIn);
      },
    });
    const sdk = hostSdk({ features: [defineFeature({ id: "lister", jobs: [featureJob] })] });
    await sdk.start();

    const id = await sdk.runner.enqueue("host.feature-job", {});

    await expect.poll(() => statusOf(sdk, id), poll).toBe("succeeded");
    expect(seen).toEqual(["function", "function"]);
    const [row] = await getTestDb()
      .select({ attempts: job.attempts })
      .from(job)
      .where(and(eq(job.id, id)));
    expect(row?.attempts).toBe(1);
  });
});
