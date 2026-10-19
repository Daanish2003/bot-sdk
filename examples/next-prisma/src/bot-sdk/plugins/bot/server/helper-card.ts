import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { EventType, type StreamChunk } from "@tanstack/ai";

import { bot, botHelper, botTurn, jobEvent } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import { type BotHelper, isLiveHelper } from "../shared/helper";
import { askUserToolName, stepsIn } from "./hand-off";
import { gistOf } from "./helper";
import { lastMessageOfTurn } from "./routine";

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
 * tool call. With `helperId`, only that one of the Bot's Helpers.
 */
export async function listHelpers(
  db: Database,
  botId: string,
  helperId?: string,
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
      transcript: botHelper.transcript,
      afterMessageId: sql<string | null>`(${lastMessageOfTurn(db)})`,
    })
    .from(botHelper)
    .innerJoin(bot, eq(bot.id, botHelper.botId))
    .innerJoin(botTurn, eq(botTurn.id, botHelper.startedByTurnId))
    .where(
      and(
        eq(botHelper.botId, botId),
        helperId === undefined ? undefined : eq(botHelper.id, helperId),
      ),
    )
    .orderBy(asc(botHelper.startedAt), asc(botHelper.id));

  const jobIds = rows.flatMap((row) => (row.jobId ? [row.jobId] : []));
  const counts = jobIds.length
    ? await db
        .select({ jobId: jobEvent.jobId, steps: sql<number>`count(*)::int` })
        .from(jobEvent)
        .where(and(inArray(jobEvent.jobId, jobIds), eq(jobEvent.name, "model")))
        .groupBy(jobEvent.jobId)
    : [];
  const stepsOf = new Map(counts.map((row) => [row.jobId, row.steps]));

  return Promise.all(
    rows.map(async ({ jobId, transcript, ...row }) => {
      let latest: string | null = null;
      if (jobId && isLiveHelper(row.status)) {
        const [call] = await db
          .select({ result: jobEvent.result })
          .from(jobEvent)
          .where(and(eq(jobEvent.jobId, jobId), eq(jobEvent.name, "model")))
          .orderBy(desc(jobEvent.seq))
          .limit(1);
        const recorded = call?.result as { chunks?: StreamChunk[] } | null | undefined;
        latest = latestToolCall(recorded?.chunks ?? []);
      }
      const handedOff = (transcript ?? []).some((message) =>
        message.toolCalls?.some((call) => call.function.name === askUserToolName),
      );
      const recorded = jobId ? (stepsOf.get(jobId) ?? 0) : 0;
      let steps = jobId ? recorded : stepsIn(transcript ?? []);
      if (handedOff) {
        steps = stepsIn(transcript!) + (row.status === "running" ? recorded : 0);
      }
      return { ...row, gist: gistOf(row.task), steps, latest };
    }),
  );
}
