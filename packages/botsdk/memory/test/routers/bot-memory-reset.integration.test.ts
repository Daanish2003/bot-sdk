import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import type { Transaction } from "@botsdk/bot/plugin";
import { botTurn, job } from "@botsdk/bot/storage";
import { botResetJobName } from "@botsdk/bot/bot/turn";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveCredentials } from "@botsdk/bot/models/internal";
import {
  claimJob,
  createWorkflow,
  inProcessRunner,
  type JobRunner,
  systemClock,
} from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { followSend } from "@ai-chat/test-support/follow-send";
import { botMemoryPassJob, type PassContext } from "../../src/server/bot-pass";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const timeout = 30_000;

/** The fake clock's "now". */
const now = new Date("2030-03-15T12:00:00Z");

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const memoryDir = (botId: string) => `/home/user/bots/${botId}/memory`;

/**
 * A user with Ada and Grace, over an SDK with `memory()` and a fake Computer whose `rm -rf -- '<dir>'`
 * deletes the files under that directory. Its Model plays `rounds`.
 */
async function adaAndGrace(rounds: Parameters<typeof round>[] = []) {
  const fake = createFakeAdapter({ rounds: rounds.map((args) => round(...args)) });
  const removed: string[] = [];
  let failing = false;
  const computerFake = fakeComputerProvider({
    onCommand: ({ command }) => {
      const dir = /^rm -rf -- '([^']+)'$/.exec(command)?.[1];
      if (dir) {
        removed.push(dir);
        if (failing) {
          failing = false;
          return { exitCode: 1, stdout: "", stderr: "Device busy" };
        }
        for (const path of computerFake.files.keys()) {
          if (path.startsWith(`${dir}/`)) computerFake.files.delete(path);
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const offset = now.getTime() - Date.now();
  const clock = () => new Date(Date.now() + offset);
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: { ...systemClock, now: clock },
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    jobs,
    adapterFor: () => fake.adapter,
    clock,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const ada = (await client.bots.create({ name: "Ada", model })).id;
  const grace = (await client.bots.create({ name: "Grace", model })).id;
  const seed = (botId: string, file: string, text: string) =>
    computerFake.files.set(`${memoryDir(botId)}/${file}`, new TextEncoder().encode(text));
  const read = (botId: string, file: string) => {
    const bytes = computerFake.files.get(`${memoryDir(botId)}/${file}`);
    return bytes ? new TextDecoder().decode(bytes) : null;
  };
  /** Makes the next delete fail. */
  const failNext = () => {
    failing = true;
  };
  return { deps, jobs, clock, client, user, ada, grace, seed, read, removed, failNext };
}

describe("a Bot reset and Memory", () => {
  it(
    "deletes the Bot's own Profile, Log and Notes, and leaves another Bot's",
    { timeout },
    async () => {
      const { deps, client, user, ada, grace, seed, read, removed } = await adaAndGrace();
      seed(ada, "profile.md", "- Lives in Berlin\n");
      seed(ada, "notes.md", "- 2030-03-14: Flight on Friday\n");
      seed(ada, "log/2030-03.md", "- 2030-03-14 [5]: Booked a flight\n");
      seed(grace, "profile.md", "- Likes espresso\n");
      // The user has a Computer.
      await deps.computer!.forUser(user.id).list("/home/user");

      await client.bots.reset({ botId: ada, name: "Ada" });

      await expect.poll(() => removed, { timeout: 10_000 }).toEqual([memoryDir(ada)]);
      expect(read(ada, "profile.md")).toBeNull();
      expect(read(ada, "notes.md")).toBeNull();
      expect(read(ada, "log/2030-03.md")).toBeNull();
      expect(read(grace, "profile.md")).toBe("- Likes espresso\n");
    },
  );

  it(
    "retries the delete in a runner job when it fails, until the files are gone",
    { timeout },
    async () => {
      const { deps, jobs, clock, client, user, ada, seed, read, removed, failNext } =
        await adaAndGrace();
      seed(ada, "profile.md", "- Lives in Berlin\n");
      await deps.computer!.forUser(user.id).list("/home/user");
      failNext();

      await client.bots.reset({ botId: ada, name: "Ada" });

      // The first attempt failed, and the job waits out its backoff.
      const retried = () =>
        getTestDb()
          .select({ id: job.id, status: job.status, attempts: job.attempts })
          .from(job)
          .where(eq(job.name, botResetJobName));
      await expect
        .poll(async () => (await retried()).map((row) => [row.status, row.attempts]), {
          timeout: 10_000,
        })
        .toEqual([["queued", 1]]);
      expect(read(ada, "profile.md")).toBe("- Lives in Berlin\n");
      const [due] = await retried();
      const claimed = await claimJob(getTestDb(), clock(), {
        respectRunAfter: false,
      });
      expect(claimed?.id).toBe(due!.id);
      await jobs.runClaimed(claimed!);

      expect(removed).toEqual([memoryDir(ada), memoryDir(ada)]);
      expect(read(ada, "profile.md")).toBeNull();
      expect((await retried()).map((row) => row.status)).toEqual(["succeeded"]);
    },
  );

  it("wakes no Computer for a user who has none", { timeout }, async () => {
    const { client, ada, removed } = await adaAndGrace();

    await client.bots.reset({ botId: ada, name: "Ada" });

    expect(removed).toEqual([]);
  });

  it(
    "writes nothing from a Turn the Bot had before its reset, even a pass that recorded its operations",
    { timeout },
    async () => {
      const { deps, client, ada, read } = await adaAndGrace([[]]);
      for await (const _event of await followSend(client, {
        botId: ada,
        id: uuidv7(),
        text: "I live in Berlin",
      })) {
        // Read to the end of the Turn.
      }
      const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, ada));
      await client.bots.reset({ botId: ada, name: "Ada" });

      // The pass of the Turn from before the reset, as a retry of an attempt that planned an add.
      const workflow = createWorkflow<Transaction>({
        history: [
          {
            seq: 1,
            kind: "activity",
            name: "memory_ops",
            result: {
              shown: [],
              ops: [{ op: "add", tier: "profile", text: "Lives in Berlin" }],
            },
          },
        ],
        store: {
          save: async () => true,
          saveWith: async (_entry, fn) => ({
            saved: true,
            result: await getTestDb().transaction(fn),
          }),
        },
        now: () => now,
      });
      await botMemoryPassJob.run(
        { turnId: turn!.id },
        {
          ...(deps.parts.jobs.get(botMemoryPassJob.name)!.services as PassContext),
          ...workflow.context,
          signal: new AbortController().signal,
        },
      );

      expect(read(ada, "profile.md")).toBeNull();
    },
  );
});
