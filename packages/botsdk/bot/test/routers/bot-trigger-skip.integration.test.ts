import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { conversationChannel } from "../../src/chat/conversation-events";
import { botCheckIn, botRoutine, botTrigger, botTurn } from "../../src/storage";
import { findBot } from "../../src/bot/conversation";
import { waitingIn } from "../../src/bot/triggers";
import { saveCredentials } from "../../src/models/internal";
import { uuidv7 } from "../../src/lib/uuidv7";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";

const model = "openai:gpt-6-luna";
const ranText = `Routine "morning-brief" ran at Thu 08:00 (UTC). x

Summarize.`;
const now = new Date("2026-10-29T12:00:00.000Z");

/** A user with a Bot, a past Turn, a Routine and a Check-in, and Triggers the tests seed by hand. */
async function botWithWaiting() {
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
  const db = getTestDb();
  const turnId = uuidv7();
  await db
    .insert(botTurn)
    .values({ id: turnId, botId, status: "complete", startedAt: now, endedAt: now });
  const routineId = uuidv7();
  await db.insert(botRoutine).values({
    id: routineId,
    botId,
    name: "morning-brief",
    prompt: "Summarize.",
    schedule: { days: ["mon"], at: "08:00" },
    timeZone: "UTC",
    state: "active",
    createdByTurnId: turnId,
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const checkInId = uuidv7();
  await db.insert(botCheckIn).values({
    id: checkInId,
    botId,
    at: now,
    note: "Look at the build",
    state: "fired",
    createdByTurnId: turnId,
    createdAt: now,
    updatedAt: now,
  });
  const trigger = (
    id: string,
    source: "user" | "routine" | "check_in" | "helper",
    channel: "web" | "schedule" | "webhook" | "helper",
    over: Partial<typeof botTrigger.$inferInsert> = {},
  ) =>
    db.insert(botTrigger).values({ id, conversationId, source, channel, receivedAt: now, ...over });
  const rowOf = async (id: string) =>
    (await db.select().from(botTrigger).where(eq(botTrigger.id, id)))[0]!;
  return {
    deps,
    user,
    client,
    botId,
    conversationId,
    turnId,
    routineId,
    checkInId,
    trigger,
    rowOf,
  };
}

describe("triggers.skip", () => {
  it(
    "skips a waiting Routine, webhook or Check-in Trigger: no Turn takes it, and Done lists it as cancelled",
    { timeout: 30_000 },
    async () => {
      const { client, conversationId, routineId, checkInId, trigger, rowOf } =
        await botWithWaiting();
      const scheduled = `routine:${routineId}:2026-10-29T08:00:00.000Z`;
      const webhook = `routine:${routineId}:hook-1`;
      const checkIn = `check_in:${checkInId}`;
      await trigger(scheduled, "routine", "schedule", { text: ranText });
      await trigger(webhook, "routine", "webhook", { text: ranText });
      await trigger(checkIn, "check_in", "schedule", { text: "Check-in" });

      for (const triggerId of [scheduled, webhook, checkIn]) {
        await client.triggers.skip({ triggerId });
      }

      for (const id of [scheduled, webhook, checkIn]) {
        expect(await rowOf(id)).toMatchObject({
          turnId: null,
          skippedAt: now,
          skipReason: "cancelled",
        });
      }
      const waiting = await getTestDb().select().from(botTrigger).where(waitingIn(conversationId));
      expect(waiting).toEqual([]);
      const botId = (await client.bots.list())[0]!.id;
      const tasks = await client.bots.tasks({ botId });
      expect(tasks.scheduled.triggers).toEqual([]);
      // The skipped Check-in fire shows once, not also as fired.
      expect(tasks.done.checkIns).toEqual([]);
      expect(tasks.done.skipped.map((t) => [t.source, t.label, t.skipReason]).sort()).toEqual([
        ["check_in", "Look at the build", "cancelled"],
        ["routine", "morning-brief", "cancelled"],
        ["routine", "morning-brief", "cancelled"],
      ]);
    },
  );

  it(
    "is idempotent: skipping a skipped Trigger keeps its first skip",
    { timeout: 30_000 },
    async () => {
      const { client, routineId, trigger, rowOf } = await botWithWaiting();
      const id = `routine:${routineId}:slot`;
      await trigger(id, "routine", "schedule", {
        skippedAt: new Date(now.getTime() - 60_000),
        skipReason: "paused",
      });

      await client.triggers.skip({ triggerId: id });

      expect(await rowOf(id)).toMatchObject({ skipReason: "paused" });
    },
  );

  it("refuses user and Helper-report Triggers", { timeout: 30_000 }, async () => {
    const { client, trigger, rowOf } = await botWithWaiting();
    const userTrigger = uuidv7();
    const helperTrigger = `helper:${uuidv7()}`;
    await trigger(userTrigger, "user", "web");
    await trigger(helperTrigger, "helper", "helper");

    for (const triggerId of [userTrigger, helperTrigger]) {
      await expect(client.triggers.skip({ triggerId })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { code: "error.triggerNotSkippable" },
      });
      expect(await rowOf(triggerId)).toMatchObject({ skippedAt: null, skipReason: null });
    }
  });

  it("refuses a Trigger a Turn has already taken", { timeout: 30_000 }, async () => {
    const { client, routineId, turnId, trigger, rowOf } = await botWithWaiting();
    const id = `routine:${routineId}:taken`;
    await trigger(id, "routine", "schedule", { turnId });

    await expect(client.triggers.skip({ triggerId: id })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { code: "error.triggerTaken" },
    });
    expect(await rowOf(id)).toMatchObject({ turnId, skippedAt: null });
  });

  it(
    "is not found for another user's Trigger, or one that does not exist",
    { timeout: 30_000 },
    async () => {
      const { routineId, trigger, rowOf } = await botWithWaiting();
      const id = `routine:${routineId}:mine`;
      await trigger(id, "routine", "schedule");
      const other = chatRpc({ user: await insertUser(), deps: createTestSdk() });

      await expect(other.triggers.skip({ triggerId: id })).rejects.toMatchObject({
        code: "NOT_FOUND",
        data: { code: "error.triggerNotFound" },
      });
      await expect(other.triggers.skip({ triggerId: "routine:nope" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await rowOf(id)).toMatchObject({ skippedAt: null });
    },
  );

  it(
    "hints the Conversation and logs a change so open Tasks views refresh",
    { timeout: 30_000 },
    async () => {
      const { deps, client, conversationId, routineId, trigger } = await botWithWaiting();
      const id = `routine:${routineId}:hinted`;
      await trigger(id, "routine", "schedule");
      const events: string[] = [];
      await deps.pubsub.subscribe(conversationChannel(conversationId), (message) => {
        events.push(message);
      });

      await client.triggers.skip({ triggerId: id });

      await expect
        .poll(() => events, { timeout: 10_000 })
        .toEqual([JSON.stringify({ type: "changed" })]);
      const log = await client.conversations.changes({ conversationId, since: 0 });
      if (log.reload) throw new Error("reload");
      const { changes } = log;
      expect(changes.map((change) => [change.kind, change.refId])).toContainEqual([
        "routine",
        routineId,
      ]);
      // Skipping it again changes nothing, so it hints nothing more.
      await client.triggers.skip({ triggerId: id });
      expect(events).toHaveLength(1);
    },
  );
});
