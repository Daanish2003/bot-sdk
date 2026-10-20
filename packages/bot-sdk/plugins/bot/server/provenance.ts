import { and, asc, eq, inArray } from "drizzle-orm";

import { botTrigger, botTurn, usage } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type {
  BotMessage,
  BotStepSection,
  BotTurnProvenance,
  BotTurnStep,
  BotTurnTrigger,
} from "../shared/turn";
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
  userId: string,
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
  const stepsOf = await turnSteps(
    db,
    userId,
    turns.map((turn) => turn.id),
  );
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
      steps: stepsOf.get(turn.id) ?? [],
    };
  });
}

/**
 * Each Turn's Steps: the user's `turn` usage rows read by `source_id`, narrowed by the user's
 * `(user_id, created_at)` index (`source_id` has no index of its own). A flagged
 * section carries the hash it had in the Step before, across Turns.
 */
async function turnSteps(
  db: Database,
  userId: string,
  turnIds: string[],
): Promise<Map<string, BotTurnStep[]>> {
  const stepsOf = new Map<string, BotTurnStep[]>();
  if (turnIds.length === 0) return stepsOf;
  const rows = await db
    .select({
      id: usage.id,
      sourceId: usage.sourceId,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costMicros: usage.costMicros,
      promptHashes: usage.promptHashes,
    })
    .from(usage)
    .where(and(eq(usage.userId, userId), eq(usage.kind, "turn"), inArray(usage.sourceId, turnIds)))
    .orderBy(asc(usage.createdAt), asc(usage.id));
  let before: BotStepSection[] = [];
  for (const row of rows) {
    const hashes = row.promptHashes ?? [];
    const flagged = hashes.find((entry) => entry.changed);
    const sections = hashes.map((entry): BotStepSection => {
      const was = entry.changed ? before.find((old) => old.name === entry.name)?.hash : undefined;
      return {
        name: entry.name,
        tokens: entry.tokens ?? 0,
        hash: entry.hash,
        ...(was === undefined ? {} : { was }),
      };
    });
    const steps = stepsOf.get(row.sourceId!) ?? [];
    steps.push({
      id: row.id,
      inputTokens: row.inputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      costMicros: row.costMicros,
      sections,
      changed: flagged ? { section: flagged.name, kind: flagged.changed! } : null,
    });
    stepsOf.set(row.sourceId!, steps);
    before = sections;
  }
  return stepsOf;
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
