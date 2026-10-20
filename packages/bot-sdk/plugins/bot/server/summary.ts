import type { ModelMessage } from "@tanstack/ai";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";

import { botPromptStart, botSummary, message } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { searchTextOf } from "../../../core/shared/message-parts";
import type { BotSummary } from "../shared/turn";
import { buildPromptStart, type PromptStartParts, userZoneAt } from "./prompt-start";
import { toBotMessage } from "./store";
import { formatterIn } from "./time-zone";

/**
 * The final message of a summary call (slide 34): sent after the Prompt start and history, so the
 * call reads the cache. The Bot's last Messages to the user are added word for word afterwards.
 */
export const summarizeInstruction =
  "(A note from the system, not from the user.) Your context is nearly full, so it will be " +
  "replaced by a summary. Write that summary now, as plain text and no tool call: what the user " +
  "has asked for, what you have found and done so far, what is still left to do, and every fact, " +
  "name, number, file path and decision you will need to carry on. Your last messages to the user " +
  "are kept word for word, so you need not repeat them.";

/** The note after a Turn's input once it summarized mid-Turn: its earlier Steps are in the Summary. */
export const midTurnNote = "[Your earlier work on this Turn is in the Summary.]";

/** How many of the Bot's last Messages to the user a Summary keeps word for word. */
const keptMessages = 3;

/** What opens the kept Messages in a Summary's text, before the time zone they are dated in. */
const keptHeader = "[Your last messages to the user, word for word, in ";

/** The runner job that summarizes a Bot's Conversation while the user is away (`summary-away.ts`). */
export const summarizeAwayJobName = "bot.summarize-away";

/** The key of a Bot's away Summary job: one per Bot at a time. */
export const awaySummaryKey = (botId: string) => `summary-away:${botId}`;

/** A Turn whose last Step's input was over this many tokens queues a Summary while away. */
export const awaySummaryTokens = 100_000;

/** How long after such a Turn the Summary runs: while the cache is still warm (slide 34). */
export const awaySummaryDelayMs = 10 * 60_000;

/**
 * Queues the away Summary of a Turn's Bot, in the transaction that ends the Turn, when its last
 * Step's input was over `awaySummaryTokens`: `awaySummaryDelayMs` after it ended, keyed
 * `summary-away:<botId>`. One already queued is replaced, so it counts from this Turn.
 */
export async function queueAwaySummary(
  deps: BotSdkContext,
  tx: Transaction,
  { botId, lastInput, endedAt }: { botId: string; lastInput: number | undefined; endedAt: Date },
): Promise<void> {
  if (lastInput === undefined || lastInput <= awaySummaryTokens) return;
  const runner = deps.plugin("runner");
  await runner.cancelIn(tx, awaySummaryKey(botId));
  await runner.enqueueIn(
    tx,
    summarizeAwayJobName,
    { botId },
    {
      idempotencyKey: awaySummaryKey(botId),
      runAfter: new Date(endedAt.getTime() + awaySummaryDelayMs),
    },
  );
}

/** Cancels the Bot's away Summary, queued or running, in `tx`: a Turn is starting. */
export async function cancelAwaySummary(
  deps: BotSdkContext,
  tx: Transaction,
  botId: string,
): Promise<void> {
  await deps.plugin("runner").cancelIn(tx, awaySummaryKey(botId));
}

const sentTime: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * The Bot's last Messages to the user up to `now`, oldest first, each quoted with its time in
 * `zone`.
 */
async function lastMessagesToUser(
  tx: Transaction,
  conversationId: string,
  now: Date,
  zone: string,
): Promise<string[]> {
  const rows = await tx
    .select({ parts: message.parts, createdAt: message.createdAt })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.role, "assistant"),
        lte(message.createdAt, now),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(keptMessages);
  const format = formatterIn(zone, sentTime);
  return rows
    .reverse()
    .map((row) => `[${format.format(row.createdAt)}] ${searchTextOf(row.parts)}`);
}

/**
 * Writes a Summary in `tx`: the model's `prose`, then the Bot's last 3 Messages to the user word for
 * word with their times. It builds a new Prompt start from `parts` whose first message holds it, and
 * returns its id. A `mid_turn` Summary's Turn keeps the Prompt start it started with: the next
 * Turn's first call compares with that, so a Turn stopped right after its Summary reads as an
 * expected change, never a bug.
 */
export async function writeSummary(
  tx: Transaction,
  { parts, prose, kind }: { parts: PromptStartParts; prose: string; kind: "away" | "mid_turn" },
): Promise<string> {
  const { turn, now } = parts;
  const zone = await userZoneAt(tx, turn);
  const kept = await lastMessagesToUser(tx, turn.conversationId, now, zone);
  const text = [
    prose.trim(),
    ...(kept.length > 0 ? ["", `${keptHeader}${zone}]`, ...kept] : []),
  ].join("\n");
  const id = uuidv7();
  await tx.insert(botSummary).values({
    id,
    botId: turn.botId,
    text,
    coversUntil: now,
    kind,
    turnId: kind === "mid_turn" ? turn.id : null,
    createdAt: now,
  });
  return buildPromptStart(tx, parts, { id, text });
}

/**
 * The Bot's Summaries, oldest first, for their cards in the thread: each one's account, without the
 * kept Messages its text ends with, and those Messages as the Conversation holds them.
 */
export async function botSummaries(
  db: Database,
  botId: string,
  conversationId: string,
): Promise<BotSummary[]> {
  // Each Summary's kept Messages, picked as `writeSummary` picks them, in one query.
  const kept = db
    .select({
      id: message.id,
      role: message.role,
      parts: message.parts,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.role, "assistant"),
        lte(message.createdAt, botSummary.createdAt),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(keptMessages)
    .as("kept");
  const rows = await db
    .select({
      id: botSummary.id,
      kind: botSummary.kind,
      text: botSummary.text,
      createdAt: botSummary.createdAt,
      kept: {
        id: kept.id,
        role: kept.role,
        parts: kept.parts,
        createdAt: kept.createdAt,
      },
    })
    .from(botSummary)
    .leftJoinLateral(kept, sql`true`)
    .where(eq(botSummary.botId, botId))
    .orderBy(asc(botSummary.createdAt), asc(botSummary.id), asc(kept.createdAt), asc(kept.id));
  const summaries = new Map<string, BotSummary>();
  for (const row of rows) {
    let summary = summaries.get(row.id);
    if (!summary) {
      summary = {
        id: row.id,
        kind: row.kind,
        at: row.createdAt,
        text: row.text.split(`

${keptHeader}`)[0]!,
        kept: [],
      };
      summaries.set(row.id, summary);
    }
    if (row.kept) summary.kept.push(toBotMessage(row.kept));
  }
  return [...summaries.values()];
}

/** The Summary a Prompt start holds: what its history carries on from. */
export type HistorySummary = {
  coversUntil: Date;
  kind: "away" | "mid_turn";
  turnId: string | null;
};

/** The Summary Prompt start `id` holds, or `undefined` when it holds none. */
export async function summaryOf(
  db: Database | Transaction,
  promptStartId: string,
): Promise<HistorySummary | undefined> {
  const [row] = await db
    .select({
      coversUntil: botSummary.coversUntil,
      kind: botSummary.kind,
      turnId: botSummary.turnId,
    })
    .from(botPromptStart)
    .innerJoin(botSummary, eq(botSummary.id, botPromptStart.summaryId))
    .where(eq(botPromptStart.id, promptStartId));
  return row;
}

type HistoryTurn = {
  id: string;
  startedAt: Date;
  input: ModelMessage[] | null;
  transcript: ModelMessage[] | null;
};

/**
 * History from `summary` on: each Turn's stored input, then its transcript, in Turn order. Turns
 * that started before the Summary are left out, except the Turn a `mid_turn` Summary was written
 * in: its input, then its transcript from the Summary's note on, as its last Steps sent them.
 */
export function historyFrom(
  turns: HistoryTurn[],
  summary: HistorySummary | undefined,
): ModelMessage[] {
  return turns.flatMap((row) => {
    const input = row.input ?? [];
    const transcript = row.transcript ?? [];
    if (!summary) return [...input, ...transcript];
    if (summary.kind === "mid_turn" && row.id === summary.turnId) {
      return [...input, ...fromLastNote(transcript)];
    }
    return row.startedAt < summary.coversUntil ? [] : [...input, ...transcript];
  });
}

/** `transcript` from its last mid-Turn note on, or nothing when it has none. */
function fromLastNote(transcript: ModelMessage[]): ModelMessage[] {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]!;
    if (entry.role === "user" && entry.content === midTurnNote) return transcript.slice(index);
  }
  return [];
}
