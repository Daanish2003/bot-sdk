import { message } from "../../../../core/server/db/schema/chat";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { createRedisConnection } from "../../../../core/server/chat/redis-connection";
import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps } from "../../../../core/server/deps";
import { createLifecycle } from "../../../../core/server/lifecycle";
import { redisRuntime, type ChatRuntime } from "../../../../core/server/runtime";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { chatRpc, sendAs } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser, type TestUser } from "../../../support/users";

/**
 * A zero-downtime deploy runs two processes over one Redis (ADR 0006). Each SDK instance here is
 * built the way `createChat` builds one, with its own `redisRuntime()`, and they share one test
 * database. Needs `TEST_REDIS_URL`; the suite is skipped without it. Its keys sit under
 * `ai-chat-96:` and are deleted when the file finishes.
 */
const redisUrl = process.env.TEST_REDIS_URL;
const keyPrefix = "ai-chat-96:";
const anthropicModel = "anthropic:claude-sonnet-5-5";

type Limits = Partial<AppDeps["limits"]>;

type Instance = {
  deps: AppDeps;
  fake: ReturnType<typeof createFakeAdapter>;
  runtime: ChatRuntime;
};

/** Two SDK instances over one Redis prefix and one database, with a signed-in user and a Conversation. */
async function twoInstances({ a = {}, b = {} }: { a?: Limits; b?: Limits } = {}) {
  const prefix = `${keyPrefix}${crypto.randomUUID()}:`;
  const user = await insertUser();
  const instance = (limits: Limits): Instance => {
    const runtime = redisRuntime({ url: redisUrl!, prefix });
    const fake = createFakeAdapter({ rounds: [round(text("Hello", " there", "!"))], manual: true });
    const deps = createTestDeps({
      adapterFor: () => fake.adapter,
      runStreams: runtime.runStreams,
      pubsub: runtime.pubsub,
      counters: runtime.counters,
      limits: { drainMs: 5_000, ...limits },
    });
    return { deps, fake, runtime };
  };
  const first = instance(a);
  const second = instance(b);
  await saveCredentials(first.deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  const conv = await insertConversation(user, { model: anthropicModel, title: "Overlap" });
  return {
    user,
    conv,
    a: first,
    b: second,
    /** Ends each instance the way an abandoned or drained process would be, then closes Redis. */
    async close() {
      await createLifecycle(first.deps).stop();
      await createLifecycle(second.deps).stop();
      await first.runtime.close?.();
      await second.runtime.close?.();
    },
  };
}

/** Starts a Run on `deps`'s instance, the way a user's POST does. */
function postRun(user: TestUser, deps: AppDeps, conversationId: string) {
  return sendAs(
    new Request("http://localhost/api/chat/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [],
        forwardedProps: {
          conversationId,
          parentId: null,
          text: "Hi",
          attachmentIds: [],
          model: anthropicModel,
          webSearch: false,
        },
      }),
    }),
    user,
    deps,
  );
}

function joinRequest(runId: string) {
  return new Request(`http://localhost/api/chat/run?offset=-1&runId=${runId}`);
}

/** The assistant Message of a Conversation, read straight from the test database. */
async function replyOf(conversationId: string) {
  const rows = await getTestDb()
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.find((row) => row.role === "assistant")!;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!redisUrl)("deploy overlap: two SDK instances on one Redis", () => {
  afterAll(async () => {
    const connection = createRedisConnection(redisUrl ?? "");
    const client = await connection.command();
    const keys: string[] = [];
    for await (const page of client.scanIterator({ MATCH: `${keyPrefix}*`, COUNT: 500 })) {
      keys.push(...page);
    }
    if (keys.length > 0) await client.del(keys);
    await connection.close();
  });

  it("a reader joining on B mid-stream gets the replay, then the rest live, then the end", async () => {
    const world = await twoInstances();
    try {
      const posting = await postRun(world.user, world.a.deps, world.conv.id);
      expect(posting.status).toBe(200);
      const reply = await replyOf(world.conv.id);

      await world.a.fake.release(3);
      const join = await sendAs(joinRequest(reply.id), world.user, world.b.deps);
      expect(join.status).toBe(200);
      const joined = join.text();
      await world.a.fake.releaseAll();
      const posted = await posting.text();

      expect(await joined).toBe(posted);
      expect(posted).toContain('"delta":"!"');
      expect(posted).toContain("RUN_FINISHED");
      expect(await replyOf(world.conv.id)).toMatchObject({ status: "complete" });
    } finally {
      await world.close();
    }
  });

  it("Stop sent to B stops a Run owned by A, which is saved stopped", async () => {
    // A's snapshot tick also reads `cancel_requested_at`, which would deliver the Stop without
    // Redis. Slow it down so only the pub/sub signal can reach A.
    const world = await twoInstances({ a: { snapshotIntervalMs: 60_000 } });
    try {
      const posting = await postRun(world.user, world.a.deps, world.conv.id);
      const reply = await replyOf(world.conv.id);
      await world.a.fake.release(1);

      await chatRpc({ user: world.user, deps: world.b.deps }).chat.stop({ messageId: reply.id });
      await posting.text();

      expect(await replyOf(world.conv.id)).toMatchObject({ status: "stopped" });
    } finally {
      await world.close();
    }
  });

  it("stop() on A drains A's Run to completion while B keeps serving", async () => {
    const world = await twoInstances();
    try {
      const posting = await postRun(world.user, world.a.deps, world.conv.id);
      const reply = await replyOf(world.conv.id);
      await world.a.fake.release(1);

      const stopping = createLifecycle(world.a.deps).stop();

      // B still serves: it joins A's Run, and starts a Run of its own in another Conversation.
      const join = await sendAs(joinRequest(reply.id), world.user, world.b.deps);
      expect(join.status).toBe(200);
      const joined = join.text();
      const other = await insertConversation(world.user, { model: anthropicModel, title: "B" });
      const onB = await postRun(world.user, world.b.deps, other.id);
      expect(onB.status).toBe(200);
      await world.b.fake.releaseAll();
      expect(await onB.text()).toContain('"delta":"!"');

      await world.a.fake.releaseAll();
      await stopping;
      const posted = await posting.text();

      expect(posted).toContain('"delta":"!"');
      expect(await joined).toBe(posted);
      expect(await replyOf(world.conv.id)).toMatchObject({ status: "complete" });
    } finally {
      await world.close();
    }
  });

  it("after A is abandoned without stop(), B's reaper ends the Run as interrupted and closes its log", async () => {
    // A is SIGKILLed: its snapshot timer never writes again, so its heartbeat stays at the Run's
    // start and expires. B's lease is short so the test doesn't wait out the default 30 s.
    const world = await twoInstances({
      a: { snapshotIntervalMs: 60_000, runCapMs: 60_000, drainMs: 100 },
      b: { leaseMs: 300 },
    });
    try {
      await postRun(world.user, world.a.deps, world.conv.id);
      const reply = await replyOf(world.conv.id);
      await world.a.fake.release(2);
      const join = await sendAs(joinRequest(reply.id), world.user, world.b.deps);
      const joined = join.text();

      await sleep(400);
      const reaper = createLifecycle(world.b.deps);
      await reaper.start();
      await reaper.stop();

      expect(await joined).toContain("interrupted");
      expect(await replyOf(world.conv.id)).toMatchObject({
        status: "error",
        error: "interrupted",
      });
    } finally {
      await world.close();
    }
  });
});
