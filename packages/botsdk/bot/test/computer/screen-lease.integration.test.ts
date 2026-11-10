import { afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { bot, botDemonstration, databaseOf, job } from "../../src/storage";
import { postgres } from "../../src/database";
import { uuidv7 } from "../../src/lib/uuidv7";
import {
  closeScreen,
  openHeldScreen,
  screenLeaseJob,
  withScreenLease,
} from "../../src/bot/helpers";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner, systemClock } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb, testDatabaseUrl } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider, type FakeCommandRun } from "@botsdk/testing/fake-computer-provider";
import type { CommandResult } from "../../src/computer/internal";
import { eq } from "drizzle-orm";

const model = "openai:gpt-6-luna";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A pool of `max` connections, closed after the test; a pool that hung is left to the process. */
function poolOf(max: number) {
  const pool = new Pool({ connectionString: testDatabaseUrl, max });
  cleanups.push(() => Promise.race([pool.end(), sleep(2_000)]));
  return databaseOf(postgres({ pool }));
}

/** A user with one Bot and a live Demonstration holding each of `slots`, over `db`. */
async function holdersOn(
  slots: number[],
  onCommand: (command: FakeCommandRun) => CommandResult | Promise<CommandResult>,
  db = getTestDb(),
) {
  const computerFake = fakeComputerProvider({ onCommand });
  const deps: TestDeps = createTestSdk({ db, computer: computerFake.provider, memory: false });
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const { id: botId } = await chatRpc({ user, deps }).bots.create({ name: "Ada", model });
  const [{ conversationId } = { conversationId: "" }] = await getTestDb()
    .select({ conversationId: bot.conversationId })
    .from(bot)
    .where(eq(bot.id, botId));
  const holders = await Promise.all(
    slots.map(async (screen) => {
      const id = uuidv7();
      await getTestDb().insert(botDemonstration).values({
        id,
        botId,
        userId: user.id,
        conversationId,
        goal: "Watch.",
        inputs: [],
        state: "recording",
        screen,
        startedAt: new Date(),
      });
      return { id, userId: user.id, slot: screen };
    }),
  );
  return { deps, botId, holders, computerFake, computer: deps.computer!.forUser(user.id) };
}

/** Fails, rather than hanging the test, when `work` doesn't finish in `ms`. */
const within = (ms: number, work: Promise<unknown>) =>
  Promise.race([
    work,
    sleep(ms).then(() => {
      throw new Error(`Still not finished after ${ms} ms`);
    }),
  ]);

const ok = { exitCode: 0, stdout: "", stderr: "" };

describe("a Screen's command under a small pool", () => {
  const poolMax = 4;

  it("lets as many opens as the pool has connections finish, and more, on different slots and the same slot", async () => {
    const { deps, botId, holders, computer, computerFake } = await holdersOn(
      [1, 2, 3, 4],
      async () => {
        await sleep(10);
        return ok;
      },
      poolOf(poolMax),
    );

    const calls = [...holders, ...holders].map((holder) =>
      openHeldScreen(deps, holder, botId, computer),
    );

    await within(20_000, Promise.all(calls));
    expect(
      computerFake.callsOf("run").filter(({ command }) => command.includes("ai-chat-screen start")),
    ).toHaveLength(calls.length);
  }, 30_000);

  it("lets as many closes as the pool has connections finish, and more", async () => {
    const { deps, holders, computerFake } = await holdersOn(
      [1, 2, 3, 4],
      async () => {
        await sleep(10);
        return ok;
      },
      poolOf(poolMax),
    );

    const calls = [...holders, ...holders].map(({ id, userId, slot }) =>
      closeScreen(deps, { id, userId, screen: slot }),
    );

    await within(20_000, Promise.all(calls));
    expect(
      computerFake.callsOf("run").filter(({ command }) => command.includes("ai-chat-screen stop")),
    ).toHaveLength(calls.length);
  }, 30_000);
});

describe("one Screen's commands", () => {
  it("run one at a time: two opens, and a close beside them, never overlap", async () => {
    const order: string[] = [];
    const { deps, botId, holders, computer } = await holdersOn([1], async ({ command }) => {
      if (!/ai-chat-screen (start|stop) 1/.test(command)) return ok;
      order.push("begin");
      await sleep(40);
      order.push("end");
      return ok;
    });
    const [holder] = holders as [(typeof holders)[number]];

    await Promise.all([
      openHeldScreen(deps, holder, botId, computer),
      openHeldScreen(deps, holder, botId, computer),
      closeScreen(deps, { id: holder.id, userId: holder.userId, screen: holder.slot }),
    ]);

    expect(order).toEqual(["begin", "end", "begin", "end", "begin", "end"]);
  }, 30_000);
});

describe("a Screen's lease", () => {
  it("frees the slot once a crashed holder's lease comes due, through the job that does nothing", async () => {
    const { deps, holders } = await holdersOn([1], () => ok);
    const [{ userId }] = holders as [(typeof holders)[number]];
    const runner: JobRunner = inProcessRunner({
      db: getTestDb(),
      logger: { error: () => {} },
      drainMs: 50,
      jobs: () => deps.parts.jobs,
      clock: systemClock,
    });
    await runner.start();
    cleanups.push(() => runner.stop());
    await getTestDb()
      .insert(job)
      .values({
        id: uuidv7(),
        name: screenLeaseJob.name,
        payload: {},
        idempotencyKey: `screen-lease:${userId}:1`,
        runAfter: new Date(Date.now() - 1_000),
      });
    let held = false;

    await within(
      20_000,
      withScreenLease(deps, userId, 1, async () => {
        held = true;
      }),
    );

    expect(held).toBe(true);
  }, 30_000);
});
