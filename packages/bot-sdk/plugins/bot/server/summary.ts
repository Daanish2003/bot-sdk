import type { ModelMessage } from "@tanstack/ai";
import { and, desc, eq, lte } from "drizzle-orm";

import { botPromptStart, botSummary, botTurn, message } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { Transaction } from "../../../core/server/plugin";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { searchTextOf } from "../../../core/shared/message-parts";
import { buildPromptStart, type PromptStartParts, userZoneAt } from "./prompt-start";
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
 * a `mid_turn` Summary points its Turn at that Prompt start. Returns the new Prompt start's id.
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
    ...(kept.length > 0
      ? ["", `[Your last messages to the user, word for word, in ${zone}]`, ...kept]
      : []),
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
  const promptStartId = await buildPromptStart(tx, parts, { id, text });
  if (kind === "mid_turn") {
    await tx.update(botTurn).set({ promptStartId }).where(eq(botTurn.id, turn.id));
  }
  return promptStartId;
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
