import { type BotHelper, isLiveHelper } from "@botsdk/client/bot/helper";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { EventType, type StreamChunk } from "@tanstack/ai";

import { bot, botHelper, botTurn } from "../../storage";
import type { Database } from "../../storage";
import { checkpointCounts, newestCheckpoints } from "../../runner/internal";
import { askUserToolName } from "./hand-off";
import { gistOf } from "./helper";
import { lastMessageOfTurn } from "../routines";

/** The longest tool-call gist, in characters. */
const latestLimit = 80;

/** The model call's newest tool call as `shell: ls -la`, or `null` when it called none. */
function latestToolCall(chunks: readonly StreamChunk[]): string | null {
  const calls = new Map<string, { name: string; json: string }>();
  for (const chunk of chunks) {
    if (chunk.type === EventType.TOOL_CALL_START) {
      calls.set(chunk.toolCallId, { name: chunk.toolCallName, json: "" });
    } else if (chunk.type === EventType.TOOL_CALL_ARGS) {
      const call = calls.get(chunk.toolCallId);
      if (call) call.json += chunk.delta;
    }
  }
  const last = [...calls.values()].at(-1);
  if (!last) return null;
  let detail = "";
  try {
    const input = JSON.parse(last.json) as Record<string, unknown>;
    const value = input.command ?? input.path;
    if (typeof value === "string") detail = value.split("\n")[0]!.trim();
  } catch {
    // Arguments that don't parse: the name alone.
  }
  const gist = detail ? `${last.name}: ${detail}` : last.name;
  return gist.length <= latestLimit ? gist : `${gist.slice(0, latestLimit - 1)}…`;
}

/**
 * The Bot's Helpers, oldest first (#590), each with `afterMessageId`, the last Message of the Turn
 * that started it (see `lastMessageOfTurn`). `steps` are the Helper's model calls so far, from its
 * job's recorded history; once the job is pruned, from its transcript. After a hand-off they are
 * the saved transcript's, plus the resumed job's while it runs. A live Helper also has its `latest`
 * tool call. With `helperIds`, only those of the Bot's Helpers.
 */
export async function listHelpers(
  db: Database,
  botId: string,
  helperIds?: string[],
): Promise<BotHelper[]> {
  const rows = await db
    .select({
      id: botHelper.id,
      type: botHelper.type,
      task: botHelper.task,
      status: botHelper.status,
      report: botHelper.report,
      startedAt: botHelper.startedAt,
      jobId: botHelper.jobId,
      // Read in SQL, so the transcript and its screenshots never leave the database.
      savedSteps: sql<number>`(select count(*)::int from jsonb_array_elements(coalesce(${botHelper.transcript}, '[]'::jsonb)) as entry where entry->>'role' = 'assistant')`,
      handedOff: sql<boolean>`coalesce(${botHelper.transcript} @> ${JSON.stringify([{ toolCalls: [{ function: { name: askUserToolName } }] }])}::jsonb, false)`,
      afterMessageId: sql<string | null>`(${lastMessageOfTurn(db)})`,
    })
    .from(botHelper)
    .innerJoin(bot, eq(bot.id, botHelper.botId))
    .innerJoin(botTurn, eq(botTurn.id, botHelper.startedByTurnId))
    .where(
      and(
        eq(botHelper.botId, botId),
        helperIds === undefined ? undefined : inArray(botHelper.id, helperIds),
      ),
    )
    .orderBy(asc(botHelper.startedAt), asc(botHelper.id));

  const jobIds = rows.flatMap((row) => (row.jobId ? [row.jobId] : []));
  const stepsOf = await checkpointCounts(db, jobIds, "model");

  // Each live Helper's newest model call, all in one query.
  const liveJobIds = rows.flatMap((row) =>
    row.jobId && isLiveHelper(row.status) ? [row.jobId] : [],
  );
  const newestOf = await newestCheckpoints(db, liveJobIds, "model");

  return rows.map(({ jobId, savedSteps, handedOff, ...row }) => {
    let latest: string | null = null;
    if (jobId && isLiveHelper(row.status)) {
      const recorded = newestOf.get(jobId) as { chunks?: StreamChunk[] } | null | undefined;
      latest = latestToolCall(recorded?.chunks ?? []);
    }
    const recorded = jobId ? (stepsOf.get(jobId) ?? 0) : 0;
    let steps = jobId ? recorded : savedSteps;
    if (handedOff) steps = savedSteps + (row.status === "running" ? recorded : 0);
    return { ...row, gist: gistOf(row.task), steps, latest };
  });
}
