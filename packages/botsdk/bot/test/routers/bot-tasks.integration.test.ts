import { describe, expect, it } from "vitest";

import {
  botCheckIn,
  botHelper,
  botRoutine,
  botTrigger,
  botTurn,
  botTurnStatus,
} from "../../src/storage";
import { findBot } from "../../src/bot/conversation";
import { saveCredentials } from "../../src/models/internal";
import { uuidv7 } from "../../src/lib/uuidv7";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";

const model = "openai:gpt-6-luna";
const now = new Date("2026-10-29T12:00:00.000Z");
const day = 24 * 60 * 60_000;
const daysAgo = (days: number) => new Date(now.getTime() - days * day);

/** A user with a Bot, on an SDK whose clock reads `now`, and rows the tests seed by hand. */
async function botWithTurn() {
  const deps = createTestSdk({ clock: () => now });
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada", model });
  const { conversationId } = (await findBot(getTestDb(), user.id, botId))!;
  const turnId = uuidv7();
  const seedTurn = (status: (typeof botTurnStatus.enumValues)[number], startedAt = daysAgo(10)) =>
    getTestDb()
      .insert(botTurn)
      .values({ id: turnId, botId, status, startedAt, endedAt: status === "running" ? null : now });
  return { client, user, botId, conversationId, turnId, seedTurn };
}

let order = 0;
const helperRow = (
  botId: string,
  startedByTurnId: string,
  task: string,
  status: (typeof botHelper.$inferInsert)["status"],
  endedAt: Date | null,
) => ({
  id: uuidv7(),
  botId,
  type: "general" as const,
  task,
  status,
  startedByTurnId,
  // Each a millisecond after the one before, for a fixed order.
  startedAt: new Date(daysAgo(20).getTime() + (order += 1)),
  endedAt,
  report: endedAt ? `Report of ${task}` : null,
});

describe("bots.tasks", () => {
  it("puts each kind of item in its section", { timeout: 30_000 }, async () => {
    const { client, botId, conversationId, turnId, seedTurn } = await botWithTurn();
    const db = getTestDb();
    await seedTurn("running", daysAgo(0));
    await db
      .insert(botHelper)
      .values([
        helperRow(botId, turnId, "Running one", "running", null),
        helperRow(botId, turnId, "Waiting one", "waiting", null),
        helperRow(botId, turnId, "Finished one", "complete", daysAgo(1)),
        helperRow(botId, turnId, "Failed one", "error", daysAgo(2)),
        helperRow(botId, turnId, "Stopped one", "stopped", daysAgo(3)),
      ]);
    const routineId = uuidv7();
    await db.insert(botRoutine).values({
      id: routineId,
      botId,
      name: "morning-brief",
      prompt: "Summarize.",
      schedule: { days: ["mon"], at: "08:00" },
      timeZone: "Europe/London",
      state: "active",
      createdByTurnId: turnId,
      approvedAt: daysAgo(5),
      createdAt: daysAgo(5),
      updatedAt: daysAgo(5),
    });
    const pendingId = uuidv7();
    const firedId = uuidv7();
    const cancelledId = uuidv7();
    const checkIn = (id: string, state: "pending" | "fired" | "cancelled", at: Date) => ({
      id,
      botId,
      at,
      note: `Note ${id.slice(-4)}`,
      state,
      createdByTurnId: turnId,
      createdAt: daysAgo(6),
      updatedAt: daysAgo(6),
    });
    await db
      .insert(botCheckIn)
      .values([
        checkIn(pendingId, "pending", new Date(now.getTime() + day)),
        checkIn(firedId, "fired", daysAgo(1)),
        checkIn(cancelledId, "cancelled", daysAgo(1)),
      ]);
    const trigger = (
      id: string,
      source: "user" | "routine" | "check_in",
      over: Partial<typeof botTrigger.$inferInsert> = {},
    ) => ({
      id,
      conversationId,
      source,
      channel: source === "routine" ? ("schedule" as const) : ("web" as const),
      receivedAt: daysAgo(0),
      ...over,
    });
    await db.insert(botTrigger).values([
      trigger(`routine:${routineId}:2026-10-29T08:00:00.000Z`, "routine", {
        text: `Routine "morning-brief" ran at Thu 08:00 (Europe/London). x\n\nSummarize.`,
      }),
      trigger(uuidv7(), "user", { receivedAt: new Date(now.getTime() + 1000) }),
      trigger(`routine:${routineId}:skipped`, "routine", {
        text: `Routine "morning-brief" ran at Wed 08:00 (Europe/London). x\n\nSummarize.`,
        receivedAt: daysAgo(2),
        skippedAt: daysAgo(2),
        skipReason: "paused",
      }),
      trigger(`routine:${routineId}:old`, "routine", {
        receivedAt: daysAgo(9),
        skippedAt: daysAgo(9),
        skipReason: "cancelled",
      }),
      trigger(uuidv7(), "user", { turnId, receivedAt: daysAgo(0) }),
    ]);

    const tasks = await client.bots.tasks({ botId });

    expect(tasks.inProgress.turn).toMatchObject({ id: turnId });
    expect(tasks.inProgress.helpers.map((h) => h.gist)).toEqual(["Running one", "Waiting one"]);
    expect(tasks.scheduled.routines.map((r) => r.name)).toEqual(["morning-brief"]);
    expect(tasks.scheduled.checkIns.map((c) => c.id)).toEqual([pendingId]);
    expect(tasks.scheduled.triggers.map((t) => [t.source, t.label])).toEqual([
      ["routine", "morning-brief"],
      ["user", null],
    ]);
    expect(tasks.done.helpers.map((h) => [h.gist, h.status, h.report])).toEqual([
      ["Finished one", "complete", "Report of Finished one"],
      ["Failed one", "error", "Report of Failed one"],
      ["Stopped one", "stopped", "Report of Stopped one"],
    ]);
    expect(tasks.done.checkIns.map((c) => c.id)).toEqual([firedId]);
    // The skipped run from 2 days ago shows with its reason; the one from 9 days ago is out of the window.
    expect(tasks.done.skipped.map((t) => [t.label, t.skipReason])).toEqual([
      ["morning-brief", "paused"],
    ]);
  });

  it(
    "labels a skipped Check-in fire and Helper report from the Trigger's own text, once their rows are gone",
    { timeout: 30_000 },
    async () => {
      const { client, botId, conversationId } = await botWithTurn();
      const skipped = (id: string, source: "check_in" | "helper", text: string) => ({
        id,
        conversationId,
        source,
        channel: source === "helper" ? ("helper" as const) : ("schedule" as const),
        text,
        receivedAt: daysAgo(1),
        skippedAt: daysAgo(1),
        skipReason: "reset" as const,
      });
      // No Check-in or Helper row: a reset deleted them.
      await getTestDb()
        .insert(botTrigger)
        .values([
          skipped(
            `check_in:${uuidv7()}`,
            "check_in",
            'Check-in you set on Tue 09:00 for Wed 09:00 (UTC): "Ask about \\"the\\" build". It\'s due now: do what the note says.',
          ),
          skipped(
            `helper:${uuidv7()}`,
            "helper",
            "General Helper finished: Find flights, status complete\n\nFound three.",
          ),
        ]);

      const tasks = await client.bots.tasks({ botId });

      expect(tasks.done.skipped.map((t) => [t.source, t.label])).toEqual([
        ["helper", "Find flights"],
        ["check_in", 'Ask about "the" build'],
      ]);
    },
  );

  it("lists at most the newest 100 skipped Triggers", { timeout: 30_000 }, async () => {
    const { client, botId, conversationId } = await botWithTurn();
    await getTestDb()
      .insert(botTrigger)
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          id: `routine:${uuidv7()}:${index}`,
          conversationId,
          source: "routine" as const,
          channel: "schedule" as const,
          receivedAt: new Date(daysAgo(1).getTime() + index * 1000),
          skippedAt: new Date(daysAgo(1).getTime() + index * 1000),
          skipReason: "paused" as const,
        })),
      );

    const tasks = await client.bots.tasks({ botId });

    expect(tasks.done.skipped).toHaveLength(100);
    expect(tasks.done.skipped[0]!.id).toMatch(/:100$/);
    expect(tasks.done.skipped.at(-1)!.id).toMatch(/:1$/);
  });

  it("is empty for a Bot that has done nothing", { timeout: 30_000 }, async () => {
    const { client, botId } = await botWithTurn();

    await expect(client.bots.tasks({ botId })).resolves.toEqual({
      inProgress: { turn: null, helpers: [] },
      scheduled: { triggers: [], routines: [], checkIns: [] },
      done: { helpers: [], checkIns: [], skipped: [] },
    });
  });

  it("is not found for another user's Bot", { timeout: 30_000 }, async () => {
    const { botId } = await botWithTurn();
    const other = chatRpc({ user: await insertUser(), deps: createTestSdk() });

    await expect(other.bots.tasks({ botId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
