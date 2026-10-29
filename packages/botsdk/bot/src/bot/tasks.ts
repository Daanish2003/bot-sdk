import { isLiveHelper } from "@botsdk/client/bot/helper";
import { type BotTasks, type TaskTrigger, tasksDoneDays } from "@botsdk/client/bot/tasks";
import { and, asc, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";

import { botHelper, botTrigger, botTurn } from "../storage";
import type { Database } from "../storage";
import { helperGistOf, helperOfTriggerId, listHelpers } from "./helpers";
import { checkInNoteOf, checkInOfKey, listCheckIns, listRoutines, routineNameOf } from "./routines";
import { waitingIn } from "./triggers";

/** The most skipped Triggers Done lists, the newest. */
export const tasksSkippedLimit = 100;

/**
 * A Bot's Tasks view (spec #1007), read for the Bot whose Conversation is `conversationId`: In
 * progress (the running Turn, the running and waiting Helpers), Scheduled (the Triggers waiting in
 * the Conversation queue, the Routines, the pending Check-ins) and Done (the Helpers that ended, the
 * Check-ins that fired and the newest `tasksSkippedLimit` Triggers skipped, within the last
 * `tasksDoneDays` days up to `now`, newest first).
 */
export async function botTasks(
  db: Database,
  { botId, conversationId, now }: { botId: string; conversationId: string; now: Date },
): Promise<BotTasks> {
  const since = new Date(now.getTime() - tasksDoneDays * 24 * 60 * 60_000);
  // Only the Helpers the view shows: the live ones, and those that ended within the window.
  const shown = db
    .select({ id: botHelper.id, endedAt: botHelper.endedAt })
    .from(botHelper)
    .where(
      and(
        eq(botHelper.botId, botId),
        or(
          inArray(botHelper.status, ["running", "waiting"]),
          gte(botHelper.endedAt, since),
          and(isNull(botHelper.endedAt), gte(botHelper.startedAt, since)),
        ),
      ),
    );
  const [running, [helpers, endings], routines, checkIns, waiting, skipped] = await Promise.all([
    db
      .select({ id: botTurn.id, startedAt: botTurn.startedAt })
      .from(botTurn)
      .where(and(eq(botTurn.botId, botId), eq(botTurn.status, "running")))
      .limit(1),
    shown.then(
      async (rows) =>
        [
          rows.length
            ? await listHelpers(
                db,
                botId,
                rows.map((row) => row.id),
              )
            : [],
          rows,
        ] as const,
    ),
    listRoutines(db, botId),
    listCheckIns(db, botId),
    db
      .select()
      .from(botTrigger)
      .where(waitingIn(conversationId))
      .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id)),
    db
      .select()
      .from(botTrigger)
      .where(and(eq(botTrigger.conversationId, conversationId), gte(botTrigger.skippedAt, since)))
      .orderBy(desc(botTrigger.skippedAt), desc(botTrigger.id))
      .limit(tasksSkippedLimit),
  ]);

  const endedAt = new Map(endings.map((ending) => [ending.id, ending.endedAt]));
  // The Trigger's own snapshot first, as a reset deletes the Check-in or Helper it came from.
  const labelOf = (row: typeof botTrigger.$inferSelect): string | null => {
    if (row.source === "routine") return routineNameOf(row.text);
    if (row.source === "check_in") {
      const checkInId = checkInOfKey(row.id);
      return (
        checkInNoteOf(row.text) ??
        checkIns.find((checkIn) => checkIn.id === checkInId)?.note ??
        null
      );
    }
    if (row.source === "helper") {
      const helperId = helperOfTriggerId(row.id);
      return (
        helperGistOf(row.text) ?? helpers.find((helper) => helper.id === helperId)?.gist ?? null
      );
    }
    return null;
  };
  const triggerOf = (row: typeof botTrigger.$inferSelect): TaskTrigger => ({
    id: row.id,
    source: row.source,
    channel: row.channel,
    label: labelOf(row),
    receivedAt: row.receivedAt,
    skippedAt: row.skippedAt,
    skipReason: row.skipReason,
  });
  const skippedCheckIns = new Set(
    skipped.flatMap((row) => {
      const checkInId = row.source === "check_in" ? checkInOfKey(row.id) : undefined;
      return checkInId ? [checkInId] : [];
    }),
  );

  return {
    inProgress: {
      turn: running[0] ?? null,
      helpers: helpers.filter((helper) => isLiveHelper(helper.status)),
    },
    scheduled: {
      triggers: waiting.map(triggerOf),
      routines,
      checkIns: checkIns.filter((checkIn) => checkIn.state === "pending"),
    },
    done: {
      helpers: helpers
        .filter((helper) => !isLiveHelper(helper.status))
        .map((helper) => ({ ...helper, endedAt: endedAt.get(helper.id) ?? null }))
        .filter((helper) => (helper.endedAt ?? helper.startedAt) >= since)
        .sort(
          (a, b) =>
            (b.endedAt ?? b.startedAt).getTime() - (a.endedAt ?? a.startedAt).getTime() ||
            (a.id < b.id ? 1 : -1),
        ),
      checkIns: checkIns
        // A fire the user skipped never reached a Turn: it shows once, under skipped.
        .filter(
          (checkIn) =>
            checkIn.state === "fired" && checkIn.at >= since && !skippedCheckIns.has(checkIn.id),
        )
        .sort((a, b) => b.at.getTime() - a.at.getTime()),
      skipped: skipped.map(triggerOf),
    },
  };
}
