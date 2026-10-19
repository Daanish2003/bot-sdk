import { and, asc, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";

import { bot, botRoutine, botTurn, message } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { Transaction } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { type BotRoutine, type RoutineSchedule, scheduleText } from "../shared/routine";
import { newestTimeZone } from "./store";
import { defaultTimeZone } from "./time-zone";

/** What `create_routine` returns once the Routine is saved: it waits for the user's Approval. */
export const routineSavedResult = "Saved; it runs once the user approves it.";

/**
 * Saves the Routine a Turn's `create_routine` call asked for (#538), `pending` until the user's
 * Approval, in the zone of the Conversation's newest user Message (UTC when it carried none).
 * Returns the tool's result: saved, or an error the Model can act on.
 */
export async function saveRoutine(
  tx: Transaction,
  {
    botId,
    conversationId,
    turnId,
    name,
    prompt,
    schedule,
    now,
  }: {
    botId: string;
    conversationId: string;
    turnId: string;
    name: string;
    prompt: string;
    schedule: RoutineSchedule;
    now: Date;
  },
): Promise<{ saved: string } | { error: string }> {
  const timeZone = (await newestTimeZone(tx, conversationId)) ?? defaultTimeZone;
  const saved = await tx
    .insert(botRoutine)
    .values({
      id: uuidv7(),
      botId,
      name,
      prompt,
      schedule,
      timeZone,
      state: "pending",
      createdByTurnId: turnId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [botRoutine.botId, botRoutine.name] })
    .returning({ id: botRoutine.id });
  if (saved.length === 0) {
    return {
      error: `Not saved: a Routine named "${name}" already exists. Choose another name.`,
    };
  }
  return { saved: routineSavedResult };
}

/**
 * The system prompt's list of the Bot's Routines (#538), sorted by name, one line each:
 * `morning-brief  weekdays 08:00 Europe/London  "<first line>"`, with `(waiting for OK)` on a
 * pending one. `undefined` when the Bot has none.
 */
export async function routinesPrompt(
  db: Database | Transaction,
  botId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({
      name: botRoutine.name,
      prompt: botRoutine.prompt,
      schedule: botRoutine.schedule,
      timeZone: botRoutine.timeZone,
      state: botRoutine.state,
    })
    .from(botRoutine)
    .where(eq(botRoutine.botId, botId))
    .orderBy(asc(botRoutine.name));
  if (rows.length === 0) return undefined;
  const lines = rows.map((row) => {
    const when = row.schedule ? scheduleText(row.schedule) : "";
    const firstLine = row.prompt.split("\n")[0]?.trim() ?? "";
    const waiting = row.state === "pending" ? " (waiting for OK)" : "";
    return `${row.name}  ${when} ${row.timeZone}  ${JSON.stringify(firstLine)}${waiting}`;
  });
  return `Your Routines:\n${lines.join("\n")}`;
}

/** Locks the Routine `routineId` of one of the user's Bots, or throws `NOT_FOUND`. */
async function ownedRoutine(db: Database | Transaction, userId: string, routineId: string) {
  const [row] = await db
    .select({ id: botRoutine.id })
    .from(botRoutine)
    .innerJoin(bot, eq(bot.id, botRoutine.botId))
    .where(and(eq(botRoutine.id, routineId), eq(bot.userId, userId)))
    // A concurrent approve and decline take turns: the second sees what the first left.
    .for("update", { of: botRoutine });
  if (!row) throw rpcError("NOT_FOUND", "error.routineNotFound", "Routine not found");
  return row;
}

/**
 * The Bot's Routines, sorted by name. Each has `afterMessageId`, the last Message of the Turn that
 * created it: its approval card follows it. That is the Bot's last Message sent by the time the Turn
 * ended, or the user's last one from before it started; a user Message sent while it ran is not.
 */
export async function listRoutines(db: Database, botId: string): Promise<BotRoutine[]> {
  const after = db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.conversationId, bot.conversationId),
        or(isNull(botTurn.endedAt), lte(message.createdAt, botTurn.endedAt)),
        or(eq(message.role, "assistant"), lt(message.createdAt, botTurn.startedAt)),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1);
  return db
    .select({
      id: botRoutine.id,
      name: botRoutine.name,
      prompt: botRoutine.prompt,
      schedule: botRoutine.schedule,
      timeZone: botRoutine.timeZone,
      state: botRoutine.state,
      approvedAt: botRoutine.approvedAt,
      createdAt: botRoutine.createdAt,
      afterMessageId: sql<string | null>`(${after})`,
    })
    .from(botRoutine)
    .innerJoin(bot, eq(bot.id, botRoutine.botId))
    .innerJoin(botTurn, eq(botTurn.id, botRoutine.createdByTurnId))
    .where(eq(botRoutine.botId, botId))
    .orderBy(asc(botRoutine.name));
}

/**
 * The user's Approval of a pending Routine: it turns `active` with `approvedAt`. A Routine that is
 * no longer pending stays as it is. Nothing wakes the Bot.
 */
export async function approveRoutine(
  db: Database,
  userId: string,
  routineId: string,
  now: Date,
): Promise<{ id: string; state: BotRoutine["state"]; approvedAt: Date | null }> {
  return db.transaction(async (tx) => {
    await ownedRoutine(tx, userId, routineId);
    await tx
      .update(botRoutine)
      .set({ state: "active", approvedAt: now, updatedAt: now })
      .where(and(eq(botRoutine.id, routineId), eq(botRoutine.state, "pending")));
    const [row] = await tx
      .select({ id: botRoutine.id, state: botRoutine.state, approvedAt: botRoutine.approvedAt })
      .from(botRoutine)
      .where(eq(botRoutine.id, routineId));
    return row!;
  });
}

/**
 * The user's no to a pending Routine: it is deleted. A Routine that is no longer pending stays as
 * it is. Nothing wakes the Bot.
 */
export async function declineRoutine(
  db: Database,
  userId: string,
  routineId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await ownedRoutine(tx, userId, routineId);
    await tx
      .delete(botRoutine)
      .where(and(eq(botRoutine.id, routineId), eq(botRoutine.state, "pending")));
  });
}
