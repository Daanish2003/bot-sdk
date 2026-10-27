import { isApproval } from "@botsdk/client/bot/rich-control";
import type {
  BotMessage,
  BotStepSection,
  BotTurnProvenance,
  BotTurnStep,
  BotTurnTrigger,
} from "@botsdk/client/bot/turn";
import type { BotSkillChange } from "@botsdk/client/skills/changes";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { botDemonstration, botTrigger, botTurn, usage } from "../../../../core/server/storage";
import type { Database } from "../../../../core/server/storage";
import { routineNameOf, slotOf } from "../routines";

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
        skillChanges: botTurn.skillChanges,
        knowledgeChanges: botTurn.knowledgeChanges,
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
        draftedSkill: botDemonstration.skillName,
      })
      .from(botTrigger)
      .innerJoin(botTurn, eq(botTurn.id, botTrigger.turnId))
      // A Demonstration's drafting pass wakes the Bot with `demonstration:<id>` (#720).
      .leftJoin(
        botDemonstration,
        and(
          eq(botDemonstration.botId, botId),
          eq(botTrigger.id, sql`'demonstration:' || ${botDemonstration.id}::text`),
        ),
      )
      .where(eq(botTurn.botId, botId))
      .orderBy(asc(botTrigger.receivedAt), asc(botTrigger.id)),
  ]);
  const stepsOf = await turnSteps(db, userId, botId);
  const triggersOf = new Map<string, BotTurnTrigger[]>();
  const draftedOf = new Map<string, BotSkillChange[]>();
  for (const trigger of triggers) {
    if (trigger.draftedSkill !== null) {
      const drafted = draftedOf.get(trigger.turnId!) ?? [];
      drafted.push({ kind: "saved", name: trigger.draftedSkill });
      draftedOf.set(trigger.turnId!, drafted);
    }
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
    // An Approval request is the system asking, not the Bot sending (spec #761).
    .filter((sent) => sent.role === "assistant" && !isApproval(sent.control?.kind))
    .map((sent) => sent.createdAt.getTime())
    .sort((a, b) => a - b);
  return turns.map((turn) => {
    const next = sentAt[firstAtOrAfter(sentAt, turn.startedAt.getTime())];
    // The Skill a drafting pass saved shows on the chip of the Turn it woke, before the Turn's own
    // changes: one chip per Skill, so the Turn's edit of the drafted Skill shows as saved.
    const drafted = draftedOf.get(turn.id) ?? [];
    const own = (turn.skillChanges ?? []).filter(
      (change) => !drafted.some((saved) => saved.name === change.name),
    );
    return {
      ...turn,
      skillChanges: drafted.length + own.length > 0 ? [...drafted, ...own] : null,
      sent: next !== undefined && next <= (turn.endedAt?.getTime() ?? Infinity),
      triggers: triggersOf.get(turn.id) ?? [],
      steps: stepsOf.get(turn.id) ?? [],
    };
  });
}

/**
 * Each of Bot `botId`'s Turns' Steps: the user's `turn` and mid-Turn `summary` usage rows joined to the Bot's Turns by
 * `source_id`, narrowed by the user's `(user_id, created_at)` index (`source_id` has no index of
 * its own). A flagged section carries the hash it had in the Step before, across Turns.
 */
async function turnSteps(
  db: Database,
  userId: string,
  botId: string,
): Promise<Map<string, BotTurnStep[]>> {
  const stepsOf = new Map<string, BotTurnStep[]>();
  const rows = await db
    .select({
      id: usage.id,
      kind: usage.kind,
      sourceId: usage.sourceId,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costMicros: usage.costMicros,
      promptHashes: usage.promptHashes,
    })
    .from(usage)
    .innerJoin(botTurn, eq(sql`${botTurn.id}::text`, usage.sourceId))
    .where(
      and(
        eq(usage.userId, userId),
        inArray(usage.kind, ["turn", "summary"]),
        eq(botTurn.botId, botId),
      ),
    )
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
      kind: row.kind === "summary" ? "summary" : "turn",
      inputTokens: row.inputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      costMicros: row.costMicros,
      sections,
      changed: flagged ? { section: flagged.name, kind: flagged.changed! } : null,
    });
    stepsOf.set(row.sourceId!, steps);
    // A summary call hashes nothing: the next Step compares with the Step before it.
    if (row.kind === "turn") before = sections;
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
