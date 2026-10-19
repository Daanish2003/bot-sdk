import { asc, eq, inArray } from "drizzle-orm";

import { botTrigger, botTurn } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { BotMessage, BotTurnProvenance } from "../shared/turn";
import { routineNameOf, slotOf } from "./routine";

/**
 * The Bot's Turns, oldest first, each with the Triggers it took and whether it sent anything (#539):
 * the web app draws a divider above a Routine's run from them, and one of its own for a quiet run.
 * `messages` are the Conversation's: a Turn sent one when the Bot's Message was saved while it ran.
 */
export async function turnProvenance(
  db: Database,
  botId: string,
  messages: BotMessage[],
): Promise<BotTurnProvenance[]> {
  const turns = await db
    .select({
      id: botTurn.id,
      status: botTurn.status,
      startedAt: botTurn.startedAt,
      endedAt: botTurn.endedAt,
    })
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));
  const triggers =
    turns.length === 0
      ? []
      : await db
          .select()
          .from(botTrigger)
          .where(
            inArray(
              botTrigger.turnId,
              turns.map((turn) => turn.id),
            ),
          )
          .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id));
  const sentAt = messages
    .filter((sent) => sent.role === "assistant")
    .map((sent) => sent.createdAt.getTime());
  return turns.map((turn) => {
    const from = turn.startedAt.getTime();
    const until = turn.endedAt?.getTime() ?? Infinity;
    return {
      ...turn,
      sent: sentAt.some((at) => at >= from && at <= until),
      triggers: triggers
        .filter((trigger) => trigger.turnId === turn.id)
        .map((trigger) => ({
          source: trigger.source,
          channel: trigger.channel,
          routineName: trigger.source === "routine" ? routineNameOf(trigger.text) : null,
          at: (trigger.channel === "schedule" && slotOf(trigger.id)) || trigger.receivedAt,
        })),
    };
  });
}
