import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { botRoutine, botTurn } from "@botsdk/bot/storage";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { createTestSdk } from "../../support/deps";
import { chatRpc } from "../../support/sdk";
import { getTestDb } from "../../support/test-database";
import { insertUser } from "../../support/users";

const model = "openai:gpt-6-luna";

/** A user with an OpenAI key, so `model` is one of their Models, and their HTTP client. */
async function aUser(deps: ReturnType<typeof createTestSdk>) {
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  return { userId: user.id, client: chatRpc({ user, deps }) };
}

describe("sdk.routines, checkIns, helpers, demonstrations and reviews, called in-process (#896)", () => {
  it("run a Routine's life with a userId as the HTTP twins do, and list what the twins list", async () => {
    const deps = createTestSdk();
    const { userId, client } = await aUser(deps);
    const { id: botId } = await deps.bots.create({ userId, name: "Ada", model });
    await deps.bots.send({ userId, botId, id: uuidv7(), text: "Hi" });
    const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
    const now = new Date();
    const routineId = uuidv7();
    await getTestDb()
      .insert(botRoutine)
      .values({
        id: routineId,
        botId,
        name: "morning-brief",
        prompt: "Summarise the news.",
        schedule: { days: ["mon" as const], at: "08:00" },
        timeZone: "Europe/London",
        state: "pending",
        createdByTurnId: turn!.id,
        createdAt: now,
        updatedAt: now,
      });

    const approved = await deps.routines.approve({ userId, routineId });
    expect(approved).toMatchObject({ id: routineId, state: "active" });
    expect(await client.routines.pause({ routineId })).toEqual({
      id: routineId,
      state: "paused",
    });
    expect(await deps.routines.resume({ userId, routineId })).toEqual({
      id: routineId,
      state: "active",
    });
    expect(await deps.routines.list({ userId, botId })).toEqual(
      await client.routines.list({ botId }),
    );
    expect(await deps.checkIns.list({ userId, botId })).toEqual(
      await client.checkIns.list({ botId }),
    );
    expect(await deps.helpers.list({ userId, botId })).toEqual(
      await client.helpers.list({ botId }),
    );
    expect(await deps.reviews.list({ userId, botId })).toEqual(
      await client.reviews.list({ botId }),
    );
    await deps.routines.delete({ userId, routineId });
    expect(await deps.routines.list({ userId, botId })).toEqual([]);
  }, 30_000);

  it("refuse another user's Bot and ids on every method", async () => {
    const deps = createTestSdk();
    const owner = await aUser(deps);
    const { id: botId } = await deps.bots.create({ userId: owner.userId, name: "Ada", model });
    const { userId } = await aUser(deps);
    const id = uuidv7();
    const notFound = { code: "NOT_FOUND" };

    await expect(deps.routines.list({ userId, botId })).rejects.toMatchObject(notFound);
    await expect(deps.checkIns.list({ userId, botId })).rejects.toMatchObject(notFound);
    await expect(deps.helpers.list({ userId, botId })).rejects.toMatchObject(notFound);
    await expect(deps.helpers.stop({ userId, botId })).rejects.toMatchObject(notFound);
    await expect(deps.reviews.list({ userId, botId })).rejects.toMatchObject(notFound);
    for (const method of ["approve", "decline", "pause", "resume", "delete", "rotate"] as const) {
      await expect(deps.routines[method]({ userId, routineId: id })).rejects.toMatchObject(
        notFound,
      );
    }
    await expect(deps.checkIns.cancel({ userId, checkInId: id })).rejects.toMatchObject(notFound);
    await expect(deps.helpers.done({ userId, helperId: id })).rejects.toMatchObject(notFound);
    await expect(deps.reviews.allow({ userId, reviewId: id })).rejects.toMatchObject(notFound);
    await expect(deps.reviews.deny({ userId, reviewId: id })).rejects.toMatchObject(notFound);
    for (const method of ["pause", "resume", "done", "cancel", "view", "steps"] as const) {
      await expect(
        deps.demonstrations[method]({ userId, demonstrationId: id }),
      ).rejects.toMatchObject(notFound);
    }
  }, 30_000);

  it("refuse an invalid id with the BAD_REQUEST their procedures answer", async () => {
    const deps = createTestSdk();
    const { userId } = await aUser(deps);

    await expect(deps.routines.approve({ userId, routineId: "not-a-uuid" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      deps.helpers.stop({ userId, botId: uuidv7(), helperId: "nope" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }, 30_000);
});
