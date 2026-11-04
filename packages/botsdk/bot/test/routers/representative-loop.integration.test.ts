import { type AnyServerTool, toolDefinition } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  defineFeature,
  defineJob,
  type FeatureContext,
  type JobContext,
  type RepresentativeLoopKit,
} from "../../src";
import { runLoop } from "../../src/bot/agent-loop";
import { uuidv7 } from "../../src/lib/uuidv7";
import { type HostProvider, quotaLookup, saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner } from "../../src/runner/internal";
import { encryptCredentials } from "../../src/credentials/encryption";
import { secretEncryption } from "../../src/bot/safety";
import { botSecret, usage } from "../../src/storage";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round, text, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";

/*
 * A Representative's loop (ticket #1188), driven as a feature will drive it: from a job of a feature
 * that declares the `representativeLoop` core service, on real Postgres with a Computer configured
 * and a fake Model. Bot and Helper keys stay pinned in bot-helper and bot-prompt-start.
 */

const model = "openai:gpt-6-luna";
const hostModel = "anthropic:claude-sonnet-5-5";
const hostProviders: HostProvider[] = [
  {
    provider: "anthropic",
    credentials: { apiKey: "sk-host-secret-never-stored" },
    models: [
      {
        modelId: "claude-sonnet-5-5",
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
];
const silent = { error: () => {} };
const timeout = 30_000;
const poll = { timeout: 10_000 };
const long = "x".repeat(200_000);

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];
type Service = FeatureContext<"representativeLoop">["representativeLoop"];
type Job = JobContext<FeatureContext<"representativeLoop">>;
type Identity = Parameters<Service["run"]>[1]["representative"];

const started: JobRunner[] = [];
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const reply = (run: () => Promise<unknown> = async () => ({ sent: true })) =>
  toolDefinition({
    name: "reply",
    description: "Reply to the Customer.",
    inputSchema: z.object({ text: z.string() }),
  }).server(run);

/** An instance with a Computer whose test feature's job plays what `play` was last set to. */
async function representativeWith(
  rounds: Round[],
  {
    key = true,
    ...overrides
  }: { key?: boolean } & Pick<TestDepsOverrides, "getQuota" | "hostProviders"> = {},
) {
  const fake = createFakeAdapter({ rounds });
  const computer = fakeComputerProvider();
  const plays: Array<(job: Job) => Promise<void>> = [];
  const turn = defineJob<{ play: number }, FeatureContext<"representativeLoop">>({
    name: "front-desk.turn",
    payload: z.object({ play: z.number() }),
    run: async ({ play }, job) => plays[play]!(job),
  });
  const feature = defineFeature({
    id: "frontDesk",
    needs: ["representativeLoop"],
    jobs: [turn],
  });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [feature],
    adapterFor: () => fake.adapter,
    memory: false,
    computer: computer.provider,
    ...overrides,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  if (key) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  // The owner's Bot: with one, the owner's Computer can wake, so a call to it would reach the provider.
  const { id: botId } = await chatRpc({ user, deps }).bots.create({
    name: "Clerk",
    model: key ? model : hostModel,
  });
  /** Queues `play` as a job and waits for it to end, with what it threw. */
  const inJob = async (play: (job: Job) => Promise<void>) => {
    let settled: { error?: unknown } | undefined;
    plays.push(async (job) => {
      try {
        await play(job);
        settled = {};
      } catch (error) {
        settled = { error };
      }
    });
    await deps!.runner.enqueue(turn.name, { play: plays.length - 1 });
    await expect.poll(() => settled, poll).toBeDefined();
    return settled!;
  };
  const identity = (customerId: string = uuidv7()): Identity => ({
    userId: user.id,
    representativeId,
    customerId,
    model,
  });
  const representativeId = uuidv7();
  /** A played Representative loop whose only tools are the ones `setup` gives. */
  const play = async (
    who: Identity,
    tools: (kit: RepresentativeLoopKit) => AnyServerTool[],
    sourceId: string = uuidv7(),
  ) => {
    let result: Awaited<ReturnType<Service["run"]>> | undefined;
    const { error } = await inJob(async (job) => {
      result = await job.representativeLoop.run(job, {
        representative: who,
        sourceId,
        input: [{ role: "user", content: "When do you open?" }],
        startedAt: new Date(),
        stepLimit: 5,
        timeLimitMs: 20_000,
        setup: async (kit) => ({ tools: tools(kit), systemPrompts: ["You are a front desk."] }),
      });
    });
    expect(error).toBeUndefined();
    return result!;
  };
  return { fake, computer, deps, user, botId, identity, representativeId, inJob, play };
}

const toolResultsIn = (call: { messages: unknown } | undefined) =>
  ((call?.messages ?? []) as Array<{ role: string; content: unknown }>)
    .filter((entry) => entry.role === "tool")
    .map((entry) => String(entry.content));

const replies = () => round(toolCall({ name: "reply", input: { text: "Nine." } }));

describe("a Representative's loop", () => {
  it(
    "cuts a long result of a live request with nothing written, and never wakes the Computer",
    async () => {
      const { fake, computer, identity, play } = await representativeWith([
        replies(),
        round(text("Done.")),
      ]);

      const played = await play(identity(), (kit) => [
        toolDefinition({
          name: "reply",
          description: "Reply.",
          inputSchema: z.object({ text: z.string() }),
        }).server((_input, context) =>
          kit.liveRequest("reply", context?.toolCallId, async () => ({ long })),
        ),
      ]);

      expect(played.error).toBeUndefined();
      const [result] = toolResultsIn(fake.calls[1]);
      expect(result).toContain("characters left out");
      expect(result).toContain("The rest was not saved.");
      expect(result).not.toContain(".outputs");
      expect(computer.calls).toEqual([]);
      expect([...computer.files.keys()]).toEqual([]);
    },
    timeout,
  );

  it(
    "masks its owner's Secret in a live request's result, and leaves one with no tool call as it is",
    async () => {
      const value = "ghp_owner_secret_value_1234";
      const { fake, deps, user, identity, play } = await representativeWith([
        replies(),
        round(text("Done.")),
      ]);
      await getTestDb()
        .insert(botSecret)
        .values({
          userId: user.id,
          name: "OWNER_TOKEN",
          encrypted: encryptCredentials({ value }, secretEncryption(deps, user.id, "OWNER_TOKEN")),
          createdAt: new Date(),
        });
      let setupRead: unknown;

      const played = await play(identity(), (kit) => [
        toolDefinition({
          name: "reply",
          description: "Reply.",
          inputSchema: z.object({ text: z.string() }),
        }).server(async (_input, context) => {
          setupRead = await kit.liveRequest("setup", undefined, async () => ({ value }));
          return kit.liveRequest("reply", context?.toolCallId, async () => ({ sent: value }));
        }),
      ]);

      expect(played.error).toBeUndefined();
      expect(toolResultsIn(fake.calls[1])).toEqual([JSON.stringify({ sent: "***" })]);
      expect(setupRead).toEqual({ value });
    },
    timeout,
  );

  it(
    "cuts a long result of a live activity with nothing written, and never wakes the Computer",
    async () => {
      const { fake, computer, identity, play } = await representativeWith([
        replies(),
        round(text("Done.")),
      ]);

      await play(identity(), (kit) => [
        toolDefinition({
          name: "reply",
          description: "Reply.",
          inputSchema: z.object({ text: z.string() }),
        }).server((_input, context) =>
          kit.liveActivity("reply", context?.toolCallId, async () => ({ long })),
        ),
      ]);

      const [result] = toolResultsIn(fake.calls[1]);
      expect(result).toContain("The rest was not saved.");
      expect(computer.calls).toEqual([]);
      expect([...computer.files.keys()]).toEqual([]);
    },
    timeout,
  );

  it(
    "cuts a long result of a tool that skips the kit, or gives no call id",
    async () => {
      const { fake, computer, identity, play } = await representativeWith([
        round(
          toolCall({ name: "plain", input: { text: "a" } }),
          toolCall({ name: "unnamed", input: { text: "b" } }),
        ),
        round(text("Done.")),
      ]);
      const tool = (name: string, run: () => Promise<unknown>) =>
        toolDefinition({
          name,
          description: name,
          inputSchema: z.object({ text: z.string() }),
        }).server(run);

      await play(identity(), (kit) => [
        tool("plain", async () => ({ long })),
        tool("unnamed", () => kit.liveRequest("unnamed", undefined, async () => ({ long }))),
      ]);

      const results = toolResultsIn(fake.calls[1]);
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.length).toBeLessThan(10_000);
        expect(result).toContain("The rest was not saved.");
      }
      expect(computer.calls).toEqual([]);
    },
    timeout,
  );

  it(
    "spills the same long result for a Bot on the same instance, so the walls above are real",
    async () => {
      const { fake, computer, deps, user, botId, inJob } = await representativeWith([
        replies(),
        round(text("Done.")),
      ]);

      await inJob(async (job) => {
        await runLoop(deps, job, {
          owner: { userId: user.id, botId, model },
          usageKind: "turn",
          sourceId: uuidv7(),
          input: [{ role: "user", content: "Hi" }],
          startedAt: new Date(),
          stepLimit: 5,
          timeLimitMs: 20_000,
          setup: async (kit) => ({
            tools: [
              toolDefinition({
                name: "reply",
                description: "Reply.",
                inputSchema: z.object({ text: z.string() }),
              }).server((_input, context) =>
                kit.liveRequest("reply", context?.toolCallId, async () => ({ long })),
              ),
            ],
            systemPrompts: ["You are a Bot."],
          }),
        });
      });

      const [path] = [...computer.files.keys()];
      expect(path?.startsWith(`/home/user/bots/${botId}/.outputs/`)).toBe(true);
      expect(toolResultsIn(fake.calls[1])[0]).toContain(`The full text is saved at ${path}.`);
      expect(computer.callsOf("create")).toHaveLength(1);
    },
    timeout,
  );

  it(
    "gives a Representative identity no Computer even through the loop's own kit",
    async () => {
      const { fake, computer, deps, identity, inJob } = await representativeWith([
        replies(),
        round(text("Done.")),
      ]);
      let kitTools: AnyServerTool[] | undefined;
      let called: unknown;
      let operated = false;

      const { error } = await inJob(async (job) => {
        await runLoop(deps, job, {
          owner: identity(),
          sourceId: uuidv7(),
          input: [{ role: "user", content: "Hi" }],
          startedAt: new Date(),
          stepLimit: 5,
          timeLimitMs: 20_000,
          setup: async (kit) => {
            kitTools = kit.computerTools;
            called = await kit.computerCall("read", "a-call", async () => {
              operated = true;
              return { ok: true };
            });
            return { tools: [reply()], systemPrompts: ["You are a front desk."] };
          },
        });
      });

      expect(error).toBeUndefined();
      expect(kitTools).toEqual([]);
      expect(called).toEqual({ error: expect.stringContaining("no Computer") });
      expect(operated).toBe(false);
      expect(computer.calls).toEqual([]);
      expect(fake.calls[0]?.tools?.map((tool) => tool.name)).toEqual(["reply"]);
    },
    timeout,
  );

  it(
    "sends the Model exactly the tools its caller passed, and none when it passed none",
    async () => {
      const { fake, identity, play } = await representativeWith([
        replies(),
        round(text("Done.")),
        round(text("Nothing to call.")),
      ]);

      await play(identity(), () => [reply()]);
      await play(identity(), () => []);

      expect(fake.calls[0]?.tools?.map((tool) => tool.name)).toEqual(["reply"]);
      expect(fake.calls[1]?.tools?.map((tool) => tool.name)).toEqual(["reply"]);
      expect(fake.calls[2]?.tools ?? []).toEqual([]);
    },
    timeout,
  );

  it(
    "keys each Customer's thread and cache apart, and each stays the same across Turns",
    async () => {
      const { fake, identity, play } = await representativeWith([
        round(text("One.")),
        round(text("Two.")),
        round(text("One again.")),
      ]);
      // Long ids that share their first characters: a Provider keeps only the key's first 64.
      const shared = "c".repeat(100);

      await play(identity(`${shared}-first`), () => []);
      await play(identity(`${shared}-second`), () => []);
      await play(identity(`${shared}-first`), () => []);

      const [first, second, again] = fake.calls;
      const key = (call: typeof first) =>
        (call?.modelOptions as { prompt_cache_key: string } | undefined)?.prompt_cache_key;
      expect(first?.threadId).toBeTruthy();
      expect(first?.threadId).not.toBe(second?.threadId);
      expect(again?.threadId).toBe(first?.threadId);
      expect(key(first)).toMatch(/^representative:/);
      expect(key(first)).not.toBe(key(second));
      expect(key(again)).toBe(key(first));
      for (const call of [first, second]) {
        expect(key(call)!.length).toBeLessThanOrEqual(64);
        expect(key(call)).not.toContain(shared);
      }
    },
    timeout,
  );

  it(
    "never shares a thread or cache key with its Bot, even with a Customer named like it",
    async () => {
      const { fake, deps, user, botId, identity, inJob, play } = await representativeWith([
        round(text("Rep.")),
        round(text("Bot.")),
      ]);

      await play(identity(botId), () => []);
      await inJob(async (job) => {
        await runLoop(deps, job, {
          owner: { userId: user.id, botId, model },
          usageKind: "turn",
          sourceId: uuidv7(),
          input: [{ role: "user", content: "Hi" }],
          startedAt: new Date(),
          stepLimit: 1,
          timeLimitMs: 20_000,
          setup: async () => ({ tools: [], systemPrompts: ["You are a Bot."] }),
        });
      });

      const [representativeCall, botCall] = fake.calls;
      expect(botCall?.threadId).toBe(botId);
      expect(botCall?.modelOptions).toEqual({ prompt_cache_key: `bot:${botId}` });
      expect(representativeCall?.threadId).not.toBe(botCall?.threadId);
      expect(representativeCall?.modelOptions).not.toEqual(botCall?.modelOptions);
    },
    timeout,
  );

  it(
    "records its model calls on the owner's Quota as representative",
    async () => {
      const { user, identity, play } = await representativeWith([replies(), round(text("Done."))]);
      const sourceId = uuidv7();

      const played = await play(identity(), () => [reply()], sourceId);

      const rows = await getTestDb()
        .select({ kind: usage.kind, sourceId: usage.sourceId, model: usage.model })
        .from(usage)
        .where(and(eq(usage.userId, user.id), eq(usage.sourceId, sourceId)));
      expect(rows).toEqual([
        { kind: "representative", sourceId, model },
        { kind: "representative", sourceId, model },
      ]);
      expect(played.usage).not.toBeNull();
    },
    timeout,
  );
});

describe("the representativeLoop service", () => {
  it(
    "throws what an activity failed with, so the job retries, rather than ending as played",
    async () => {
      const { identity, inJob } = await representativeWith([replies()]);
      const failed = new Error("The Checkpoint didn't save");

      const { error } = await inJob(async (job) => {
        await job.representativeLoop.run(job, {
          representative: identity(),
          sourceId: uuidv7(),
          input: [{ role: "user", content: "Hi" }],
          startedAt: new Date(),
          stepLimit: 5,
          timeLimitMs: 20_000,
          setup: async (kit) => ({
            tools: [
              toolDefinition({
                name: "reply",
                description: "Reply.",
                inputSchema: z.object({ text: z.string() }),
              }).server((_input, context) =>
                kit.liveActivity("reply", context?.toolCallId, async () => {
                  throw failed;
                }),
              ),
            ],
            systemPrompts: [],
          }),
        });
      });

      expect(error).toBe(failed);
    },
    timeout,
  );

  it(
    "makes no model call once the owner's Quota is spent, and says so",
    async () => {
      const { fake, user, identity, inJob } = await representativeWith([round(text("Never."))], {
        hostProviders,
        // 200 micros a day.
        getQuota: quotaLookup({ budgetUsd: 0.0002, window: "day" }),
        key: false,
      });
      await getTestDb().insert(usage).values({
        id: uuidv7(),
        userId: user.id,
        kind: "turn",
        model: hostModel,
        inputTokens: 100,
        outputTokens: 0,
        costMicros: 300,
        estimated: false,
        createdAt: new Date(),
      });
      let quotaSpent: boolean | undefined;

      const { error } = await inJob(async (job) => {
        const played = await job.representativeLoop.run(job, {
          representative: { ...identity(), model: hostModel },
          sourceId: uuidv7(),
          input: [{ role: "user", content: "Hi" }],
          startedAt: new Date(),
          stepLimit: 1,
          timeLimitMs: 20_000,
          setup: async () => ({ tools: [], systemPrompts: [] }),
        });
        quotaSpent = played.quotaSpent;
      });

      expect(error).toBeUndefined();
      expect(quotaSpent).toBe(true);
      expect(fake.calls).toEqual([]);
    },
    timeout,
  );

  it(
    "ends before a model call the owner's check stops, and says so",
    async () => {
      const { fake, identity, inJob } = await representativeWith([
        replies(),
        round(text("Never.")),
      ]);
      let asked = 0;
      let played: Awaited<ReturnType<Service["run"]>> | undefined;

      const { error } = await inJob(async (job) => {
        played = await job.representativeLoop.run(job, {
          representative: identity(),
          sourceId: uuidv7(),
          input: [{ role: "user", content: "Hi" }],
          startedAt: new Date(),
          stepLimit: 5,
          timeLimitMs: 20_000,
          // The first model call is let through; the second is stopped.
          stopBefore: async () => ++asked > 1,
          setup: async () => ({ tools: [reply()], systemPrompts: [] }),
        });
      });

      expect(error).toBeUndefined();
      expect(played?.capped).toBe(true);
      expect(fake.calls).toHaveLength(1);
    },
    timeout,
  );

  it(
    "refuses a Bot's identity before any model call",
    async () => {
      const { fake, user, inJob } = await representativeWith([round(text("Never."))]);
      const botId = uuidv7();
      const asks = [
        { userId: user.id, botId, model },
        // A Bot's id beside a Representative's: still not a Representative's identity.
        { userId: user.id, botId, representativeId: uuidv7(), customerId: uuidv7(), model },
        { userId: user.id, representativeId: uuidv7(), model },
        { userId: user.id, customerId: uuidv7(), model },
      ];

      for (const ask of asks) {
        const { error } = await inJob(async (job) => {
          await job.representativeLoop.run(job, {
            representative: ask as never,
            sourceId: uuidv7(),
            input: [{ role: "user", content: "Hi" }],
            startedAt: new Date(),
            stepLimit: 1,
            timeLimitMs: 20_000,
            setup: async () => ({ tools: [], systemPrompts: [] }),
          });
        });
        expect(error).toMatchObject({ name: "PermanentJobError" });
      }

      expect(fake.calls).toEqual([]);
    },
    timeout,
  );

  it(
    "takes nothing from a caller that a Bot's loop would take",
    async () => {
      const { fake, computer, user, identity, inJob } = await representativeWith([
        round(text("Hello.")),
      ]);
      const sourceId = uuidv7();
      let kit: object | undefined;

      await inJob(async (job) => {
        await job.representativeLoop.run(job, {
          representative: identity(),
          sourceId,
          input: [{ role: "user", content: "Hi" }],
          startedAt: new Date(),
          stepLimit: 1,
          timeLimitMs: 20_000,
          // None of these is the service's: a caller that casts its way past the types gets none.
          ...({
            usageKind: "turn",
            review: { conversationId: "c" },
            owner: { botId: "b" },
          } as object),
          setup: async (given) => {
            kit = given;
            return {
              tools: [],
              systemPrompts: ["A front desk."],
              ...({ promptStart: { system: [], tools: [], firstMessage: "leak" } } as object),
            };
          },
        });
      });

      expect(Object.keys(kit!).sort()).toEqual(["liveActivity", "liveRequest", "signal"]);
      expect(JSON.stringify(fake.calls[0]?.messages)).not.toContain("leak");
      const [row] = await getTestDb()
        .select({ kind: usage.kind })
        .from(usage)
        .where(and(eq(usage.userId, user.id), eq(usage.sourceId, sourceId)));
      expect(row?.kind).toBe("representative");
      expect(computer.calls).toEqual([]);
    },
    timeout,
  );

  it("is typed to a Representative's identity, and held only by a feature that declares it", () => {
    expectTypeOf<Identity>().toEqualTypeOf<{
      userId: string;
      representativeId: string;
      customerId: string;
      model: string;
    }>();
    // @ts-expect-error -- a feature can't run a Bot's loop.
    const refused: Identity = { userId: "u", botId: "b", model };
    expect(refused).toBeTruthy();
    expectTypeOf<FeatureContext>().not.toHaveProperty("representativeLoop");
    expectTypeOf<FeatureContext<"representativeLoop">>().toHaveProperty("representativeLoop");
  });

  it(
    "isn't in the context of a feature that doesn't declare it",
    async () => {
      const seen: { context?: object } = {};
      const feature = defineFeature({
        id: "plain",
        api: (context) => {
          seen.context = context;
          return {};
        },
      });
      createTestSdk({ features: [feature], memory: false });
      expect(seen.context).toBeDefined();
      expect(seen.context).not.toHaveProperty("representativeLoop");
    },
    timeout,
  );
});
