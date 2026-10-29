import type { BotMessage, BotSummary } from "@botsdk/client/bot/turn";
import { searchTextOf } from "@botsdk/client/message-parts";
import type { ModelMessage } from "@tanstack/ai";
import { and, asc, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";

import { botPromptStart, botSummary, botTurn, message } from "../../storage";
import type { Database } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import { uuidv7 } from "../../lib/uuidv7";
import { buildPromptStart, type PromptStartParts, userZoneAt } from "./prompt-start";
import { noResetAfter } from "./reset-mark";
import { midTurnNote } from "../agent-loop";
import { awaySummaryKey } from "../triggers";
import { toBotMessage, recordBotChange, formatterIn } from "../conversation";

/** How many of the Bot's last Messages to the user a Summary keeps word for word. */
const keptMessages = 3;

/** What opens the kept Messages in a Summary's text, before the time zone they are dated in. */
const keptHeader = "[Your last messages to the user, word for word, in ";

/** The runner job that summarizes a Bot's Conversation while the user is away (`summary-away.ts`). */
export const summarizeAwayJobName = "bot.summarize-away";

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
  const runner = deps.runner;
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
        noResetAfter(tx, { conversationId }, message.createdAt),
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
 * word with their times, a `summary` change in the thread. It builds a new Prompt start from `parts`
 * whose first message holds it, and returns its id. A `mid_turn` Summary's Turn keeps the Prompt start it started with: the next
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
  await recordBotChange(tx, turn, "summary", id, now);
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
      summary = { id: row.id, kind: row.kind, at: row.createdAt, text: row.text, kept: [] };
      summaries.set(row.id, summary);
    }
    if (row.kept) summary.kept.push(toBotMessage(row.kept));
  }
  for (const summary of summaries.values()) summary.text = accountOf(summary.text, summary.kept);
  return [...summaries.values()];
}

/**
 * A Summary's account: its `text` without the block of `kept` Messages it ends with. The prose or
 * a kept Message may quote the block's header too, so the block is the last header that every kept
 * Message follows.
 */
function accountOf(text: string, kept: BotMessage[]): string {
  if (kept.length === 0) return text;
  const marker = `\n\n${keptHeader}`;
  const last = text.lastIndexOf(marker);
  for (let at = last; at >= 0; at = at > 0 ? text.lastIndexOf(marker, at - 1) : -1) {
    const block = text.slice(at);
    if (kept.every((message) => block.includes(message.text))) return text.slice(0, at);
  }
  // The kept Messages no longer read as they were written: the block is the last header.
  return last >= 0 ? text.slice(0, last) : text;
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

/**
 * The Bot's Turns that `historyFrom` keeps after `summary`, in Turn order: those since the
 * Summary, and the one a mid-Turn one was written in, started before `before` when given. Only
 * those are read, never the whole history.
 */
export function historyTurns(
  db: Database | Transaction,
  botId: string,
  summary: HistorySummary | undefined,
  before?: Date,
) {
  return db
    .select({
      id: botTurn.id,
      startedAt: botTurn.startedAt,
      input: botTurn.input,
      transcript: botTurn.transcript,
      promptStartId: botTurn.promptStartId,
    })
    .from(botTurn)
    .where(
      and(
        eq(botTurn.botId, botId),
        before ? lt(botTurn.startedAt, before) : undefined,
        // Nothing from before the Bot's latest reset mark (spec #1007).
        noResetAfter(db, { botId: botTurn.botId }, botTurn.startedAt),
        summary
          ? or(
              gte(botTurn.startedAt, summary.coversUntil),
              summary.turnId ? eq(botTurn.id, summary.turnId) : undefined,
            )
          : undefined,
      ),
    )
    .orderBy(asc(botTurn.startedAt), asc(botTurn.id));
}

/**
 * The history the Bot's next Turn sends after Prompt start `promptStartId`, as `historyFrom` keeps
 * it: what a summary call or a warming call sends too, so each reads or writes the Turn's cache.
 */
export async function historyAfter(
  db: Database | Transaction,
  botId: string,
  promptStartId: string,
): Promise<ModelMessage[]> {
  const summary = await summaryOf(db, promptStartId);
  return historyFrom(await historyTurns(db, botId, summary), summary);
}

/** `transcript` from its last mid-Turn note on, or nothing when it has none. */
function fromLastNote(transcript: ModelMessage[]): ModelMessage[] {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]!;
    if (entry.role === "user" && entry.content === midTurnNote) return transcript.slice(index);
  }
  return [];
}
