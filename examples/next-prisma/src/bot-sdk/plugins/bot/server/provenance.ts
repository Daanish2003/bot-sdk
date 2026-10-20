import { asc, eq } from "drizzle-orm";

import { botTrigger, botTurn } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { BotMessage, BotTurnProvenance, BotTurnTrigger } from "../shared/turn";
import { routineNameOf, slotOf } from "./routine";

/**
 * The Bot's Turns, oldest first, each with the Triggers it took and whether it sent anything (#539):
 * the web app draws a divider above a Routine's run from them, and one of its own for a quiet run.
 * `messages` are the Conversation's, oldest first: a Turn sent one when the Bot's Message was saved
 * while it ran. The Triggers come joined to the Bot's Turns in SQL, and both are matched up in one
 * pass, so the read grows with the Bot's history no faster than its Messages do.
 */
export async function turnProvenance(
  db: Database,
  botId: string,
  messages: BotMessage[],
): Promise<BotTurnProvenance[]> {
  const [turns, triggers] = await Promise.all([
    db
      .select({
        id: botTurn.id,
        status: botTurn.status,
        startedAt: botTurn.startedAt,
        endedAt: botTurn.endedAt,
        memoryChanges: botTurn.memoryChanges,
      })
      .from(botTurn)
      .where(eq(botTurn.botId, botId))
      .orderBy(asc(botTurn.startedAt), asc(botTurn.id)),
    db
      .select({
        id: botTrigger.id,
        turnId: botTrigger.turnId,
        source: botTrigger.source,
        channel: botTrigger.channel,
        text: botTrigger.text,
        receivedAt: botTrigger.receivedAt,
      })
      .from(botTrigger)
      .innerJoin(botTurn, eq(botTurn.id, botTrigger.turnId))
      .where(eq(botTurn.botId, botId))
      .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id)),
  ]);
  const triggersOf = new Map<string, BotTurnTrigger[]>();
  for (const trigger of triggers) {
    const taken = triggersOf.get(trigger.turnId!) ?? [];
    taken.push({
      source: trigger.source,
      channel: trigger.channel,
      routineName: trigger.source === "routine" ? routineNameOf(trigger.text) : null,
      at: (trigger.channel === "schedule" && slotOf(trigger.id)) || trigger.receivedAt,
    });
    triggersOf.set(trigger.turnId!, taken);
  }
  const sentAt = messages
    .filter((sent) => sent.role === "assistant")
    .map((sent) => sent.createdAt.getTime())
    .sort((a, b) => a - b);
  return turns.map((turn) => {
    const next = sentAt[firstAtOrAfter(sentAt, turn.startedAt.getTime())];
    return {
      ...turn,
      sent: next !== undefined && next <= (turn.endedAt?.getTime() ?? Infinity),
      triggers: triggersOf.get(turn.id) ?? [],
    };
  });
}

/** The index of the first of the ascending `times` at or after `at` (`times.length` for none). */
function firstAtOrAfter(times: number[], at: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle]! < at) low = middle + 1;
    else high = middle;
  }
  return low;
}
