import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { and, asc, eq, like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botCheckIn, botTrigger, job, usage } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { deleteUserData } from "../../../../core/server/user-data";
import type { HostProvider } from "../../../../plugins/assistant/server/deps";
import { bot } from "../../../../plugins/bot/server/plugin";
import { findBot } from "../../../../plugins/bot/server/store";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { claimJob, runClaimedJob } from "../../../../plugins/runner/server/jobs/store";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { fakeJobClock } from "../../../support/jobs";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const model = "openai:gpt-5.6";
const silent = { error: () => {} };
type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: InProcessRunner[] = [];
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

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

const setCheckIn = (input: unknown) => toolCall({ name: "set_check_in", input });
const cancelCheckIn = (input: unknown) => toolCall({ name: "cancel_check_in", input });
const listCheckIns = () => toolCall({ name: "list_check_ins", input: {} });

// Monday 19 October 2026, 10:00 in London (summer time, UTC+1).
const monday = new Date("2026-10-19T09:00:00.000Z");
// Thursday 22 October, 09:00 in London.
const thursday = "2026-10-22T09:00:00+01:00";
const thursdayUtc = "2026-10-22T08:00:00.000Z";
const note = "Has Acme replied?";

/**
 * A Bot on an idle runner and a clock the test moves. Its first Turn, started by a Message sent at
 * `monday` from London, plays `rounds`; `runDue()` runs every job due at the clock time.
 */
async function botTurn({
  rounds,
  host = false,
  getQuota,
  isUserBlocked,
}: { rounds: Round[]; host?: boolean } & Pick<TestDepsOverrides, "getQuota" | "isUserBlocked">) {
  const timer = fakeJobClock(monday);
  const fake = createFakeAdapter({ rounds });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    deps: () => deps!,
  });
  deps = createTestSdk({
    plugins: [bot()],
    jobs,
    adapterFor: () => fake.adapter,
    clock: timer.clock.now,
    ...(host && { hostProviders }),
    getQuota,
    isUserBlocked,
  });
  started.push(jobs);
  const user = await insertUser();
  if (!host) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bot.create({ name: "Ada", model: host ? hostModel : model });
  const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await runClaimedJob(getTestDb(), claimed, {
        clock: timer.clock,
        logger: silent,
        deps: () => deps!,
      });
    }
  };
  const advanceTo = (when: string | Date) => {
    timer.advance(new Date(when).getTime() - timer.clock.now().getTime());
  };
  const stream = await client.bot.send({
    botId,
    id: uuidv7(),
    text: "Remind me about Acme",
    timeZone: "Europe/London",
  });
  await stream.next();
  await stream.return(undefined);
  timer.advance(500);
  await runDue();
  return { fake, deps, client, user, botId, conversationId, runDue, advanceTo };
}

const checkIns = (botId: string) =>
  getTestDb().select().from(botCheckIn).where(eq(botCheckIn.botId, botId));

const checkInTriggers = (conversationId: string) =>
  getTestDb()
    .select()
    .from(botTrigger)
    .where(and(eq(botTrigger.conversationId, conversationId), eq(botTrigger.source, "check_in")))
    .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id));

const queuedJobs = async () =>
  (
    await getTestDb()
      .select({ key: job.idempotencyKey, runAfter: job.runAfter, status: job.status })
      .from(job)
      .where(like(job.idempotencyKey, "check_in:%"))
  ).filter((row) => row.status === "queued" || row.status === "running");

const inputOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

/** The id a set_check_in call returned, read from the Model input. */
const savedId = (options: TextOptions) =>
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{22}/.exec(JSON.stringify(options.messages))![0];

const setThursday = { at: thursday, note };

describe("a Check-in", () => {
  it("set_check_in creates a pending row and its job under check_in:<id>, and list_check_ins returns it", async () => {
    const { fake, botId } = await botTurn({
      rounds: [round(setCheckIn(setThursday)), round(listCheckIns()), round()],
    });

    const [row] = await checkIns(botId);
    expect(row).toMatchObject({ botId, note, state: "pending", at: new Date(thursdayUtc) });
    expect(await queuedJobs()).toEqual([
      { key: `check_in:${row!.id}`, runAfter: new Date(thursdayUtc), status: "queued" },
    ]);
    const listed = JSON.stringify(inputOf(fake.calls[2]));
    expect(listed).toContain(row!.id);
    expect(listed).toContain(note);
  });

  it("refuses an at less than a minute ahead with a clear tool error and saves nothing", async () => {
    const { fake, botId } = await botTurn({
      rounds: [round(setCheckIn({ at: "2026-10-19T10:00:30+01:00", note })), round()],
    });

    expect(await checkIns(botId)).toEqual([]);
    expect(await queuedJobs()).toEqual([]);
    expect(JSON.stringify(inputOf(fake.calls[1]))).toContain("at least a minute");
  });

  it("fires once past at: one check_in / schedule Trigger with the notice, the Model reads it, and it becomes fired", async () => {
    const { fake, botId, conversationId, runDue, advanceTo } = await botTurn({
      rounds: [round(setCheckIn(setThursday)), round(), round()],
    });
    advanceTo("2026-10-22T07:59:59.000Z");
    await runDue();
    expect(await checkInTriggers(conversationId)).toEqual([]);

    advanceTo(thursdayUtc);
    await runDue();
    const [row] = await checkIns(botId);
    const notice =
      `Check-in you set on Mon 2026-10-19 10:00 for Thu 2026-10-22 09:00 (Europe/London): ` +
      `"${note}". It's due now: do what the note says.`;
    expect(await checkInTriggers(conversationId)).toEqual([
      expect.objectContaining({
        id: `check_in:${row!.id}`,
        source: "check_in",
        channel: "schedule",
        messageId: null,
        text: notice,
      }),
    ]);
    expect(row!.state).toBe("fired");

    advanceTo("2026-10-22T08:00:00.500Z");
    await runDue();
    expect(inputOf(fake.calls.at(-1)).at(-1)).toEqual({
      role: "user",
      content: `[Current time: Thursday, 22 October 2026 at 09:00 (Europe/London)]\n\n${notice}`,
    });
    expect(await queuedJobs()).toEqual([]);
  });

  it("cancel_check_in stops it from firing", async () => {
    const { botId, conversationId, runDue, advanceTo } = await botTurn({
      rounds: [
        round(setCheckIn(setThursday)),
        (options) => round(cancelCheckIn({ id: savedId(options) })),
        round(),
      ],
    });

    expect((await checkIns(botId))[0]?.state).toBe("cancelled");
    expect(await queuedJobs()).toEqual([]);
    advanceTo(thursdayUtc);
    await runDue();
    expect(await checkInTriggers(conversationId)).toEqual([]);
  });

  it("the router cancel stops it from firing, and another user gets NOT_FOUND", async () => {
    const { deps, client, botId, conversationId, runDue, advanceTo } = await botTurn({
      rounds: [round(setCheckIn(setThursday)), round()],
    });
    const [listed] = await client.bot.checkIn.list({ botId });
    expect(listed).toMatchObject({ note, state: "pending", at: new Date(thursdayUtc) });
    expect(listed!.afterMessageId).toEqual(expect.any(String));

    const other = chatRpc({ user: await insertUser(), deps });
    await expect(other.bot.checkIn.cancel({ checkInId: listed!.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await checkIns(botId))[0]?.state).toBe("pending");

    await client.bot.checkIn.cancel({ checkInId: listed!.id });
    expect((await client.bot.checkIn.list({ botId }))[0]?.state).toBe("cancelled");
    expect(await queuedJobs()).toEqual([]);
    advanceTo(thursdayUtc);
    await runDue();
    expect(await checkInTriggers(conversationId)).toEqual([]);
  });

  it("makes no Trigger while the user Quota is spent", async () => {
    let quota: Awaited<ReturnType<NonNullable<TestDepsOverrides["getQuota"]>>> = null;
    const { user, conversationId, runDue, advanceTo } = await botTurn({
      rounds: [round(setCheckIn(setThursday)), round()],
      host: true,
      getQuota: async () => quota,
    });
    quota = { budgetUsd: 0.0002, window: "month" };
    await getTestDb().insert(usage).values({
      id: uuidv7(),
      userId: user.id,
      kind: "turn",
      model: hostModel,
      inputTokens: 100,
      outputTokens: 0,
      costMicros: 1_000_000,
      estimated: false,
      createdAt: new Date(),
    });

    advanceTo(thursdayUtc);
    await runDue();

    expect(await checkInTriggers(conversationId)).toEqual([]);
  });

  it("makes no Trigger while the user is Banned", async () => {
    let banned = false;
    const { conversationId, runDue, advanceTo } = await botTurn({
      rounds: [round(setCheckIn(setThursday)), round()],
      isUserBlocked: async () => banned,
    });
    banned = true;

    advanceTo(thursdayUtc);
    await runDue();

    expect(await checkInTriggers(conversationId)).toEqual([]);
  });

  it("is failed, with no Trigger, once its fire fails every attempt, so it never stays pending", async () => {
    let failing = false;
    const { botId, conversationId, runDue, advanceTo } = await botTurn({
      rounds: [round(setCheckIn(setThursday)), round()],
      host: true,
      getQuota: async () => {
        if (failing) throw new Error("The Quota store is down");
        return null;
      },
    });
    failing = true;

    advanceTo(thursdayUtc);
    await runDue();
    // Past every backoff.
    for (const hour of ["09", "10", "11", "12"]) {
      advanceTo(`2026-10-22T${hour}:00:00.000Z`);
      await runDue();
    }

    const failed = await getTestDb()
      .select({ status: job.status })
      .from(job)
      .where(like(job.idempotencyKey, "check_in:%"));
    expect(failed).toEqual([{ status: "failed" }]);
    expect((await checkIns(botId)).map((row) => row.state)).toEqual(["failed"]);
    expect(await checkInTriggers(conversationId)).toEqual([]);
  });

  it("leaves no queued Check-in job once the user is deleted", async () => {
    const { deps, user } = await botTurn({ rounds: [round(setCheckIn(setThursday)), round()] });
    expect(await queuedJobs()).toHaveLength(1);

    await deleteUserData(deps, user.id);

    expect(await queuedJobs()).toEqual([]);
  });
});
