import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { deleteConversations } from "../../../core/server/chat/delete-conversations";
import {
  bot,
  botTurn,
  conversation,
  message,
  type MessageRow,
} from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { Transaction, UserDeleteHooks } from "../../../core/server/plugin";
import { searchTextOf } from "../../../core/shared/message-parts";
import type { BotMessage, BotTurnStatus } from "../shared/turn";

/** The `kind` of every Bot's Conversation: the plugin's id. */
export const botKind = "bot";

const botColumns = { id: bot.id, name: bot.name, model: bot.model, createdAt: bot.createdAt };

/** A Bot as the client sees it. */
export type Bot = { id: string; name: string; model: string; createdAt: Date };

/** A Bot with the status of its latest Turn (`null` before its first). */
export type BotWithStatus = Bot & { turnStatus: BotTurnStatus | null };

/** A Bot in the list: its last sent Message's text and time (`null` before it has sent one). */
export type ListedBot = BotWithStatus & { lastMessage: { text: string; at: Date } | null };

export type { BotMessage };

/** A Bot Conversation Message's stored parts: one base `text` part. */
export function textParts(text: string): MessageRow["parts"] {
  return { schemaVersion: 1, parts: [{ type: "text", text }] };
}

/** A Message row as the client sees it. */
export function toBotMessage(
  row: Pick<MessageRow, "id" | "role" | "parts" | "createdAt">,
): BotMessage {
  return { id: row.id, role: row.role, text: searchTextOf(row.parts), createdAt: row.createdAt };
}

/** Creates a Bot and its empty Conversation (kind `bot`, no title) in one transaction. */
export async function createBot(
  db: Database,
  userId: string,
  { name, model }: { name: string; model: string },
): Promise<Bot> {
  return db.transaction(async (tx) => {
    const conversationId = uuidv7();
    await tx.insert(conversation).values({ id: conversationId, userId, kind: botKind });
    const [row] = await tx
      .insert(bot)
      .values({ id: uuidv7(), userId, conversationId, name, model })
      .returning(botColumns);
    if (!row) throw new Error("Inserting the Bot returned no row");
    return row;
  });
}

/** The longest a Turn may run; past it, it ends `error` with `timed_out`. */
export const turnTimeLimitMs = 5 * 60_000;

/** A running Turn writes its `heartbeat_at` this often (the same as a job's, ADR 0011). */
export const turnHeartbeatMs = 10_000;

/** A `running` Turn whose heartbeat is older than this, or null, was left by a dead process. */
export const turnLeaseMs = 60_000;

/** Whether a `running` Turn's process is dead at `now`: its heartbeat is null or past the lease. */
export function isDeadTurn(heartbeatAt: Date | null, now: Date) {
  return heartbeatAt === null || now.getTime() - heartbeatAt.getTime() > turnLeaseMs;
}

/**
 * The status of each Bot's latest Turn; a Bot with no Turn has no entry. A dead `running` Turn
 * reads as `error`, so a client stops waiting on a Turn no process will end.
 */
async function latestTurnStatuses(db: Database | Transaction, botIds: string[], now: Date) {
  if (botIds.length === 0) return new Map<string, BotTurnStatus>();
  const rows = await db
    .selectDistinctOn([botTurn.botId], {
      botId: botTurn.botId,
      status: botTurn.status,
      heartbeatAt: botTurn.heartbeatAt,
    })
    .from(botTurn)
    .where(inArray(botTurn.botId, botIds))
    .orderBy(botTurn.botId, desc(botTurn.startedAt), desc(botTurn.id));
  return new Map(
    rows.map((row): [string, BotTurnStatus] => [
      row.botId,
      row.status === "running" && isDeadTurn(row.heartbeatAt, now) ? "error" : row.status,
    ]),
  );
}

/** The latest Turn's status of one Bot at `now`, `null` before its first Turn. */
export async function latestTurnStatus(db: Database | Transaction, botId: string, now: Date) {
  return (await latestTurnStatuses(db, [botId], now)).get(botId) ?? null;
}

/**
 * The user's Bots, the newest activity in their Conversation first, each with its last sent Message
 * and its latest Turn's status at `now`.
 */
export async function listBots(db: Database, userId: string, now: Date): Promise<ListedBot[]> {
  const rows = await db
    .select({ ...botColumns, conversationId: bot.conversationId })
    .from(bot)
    .innerJoin(conversation, eq(conversation.id, bot.conversationId))
    .where(eq(bot.userId, userId))
    .orderBy(desc(conversation.lastMessageAt), desc(bot.id));
  const conversationIds = rows.map((row) => row.conversationId);
  const [statuses, sent] = await Promise.all([
    latestTurnStatuses(
      db,
      rows.map((row) => row.id),
      now,
    ),
    conversationIds.length === 0
      ? []
      : db
          .selectDistinctOn([message.conversationId], {
            conversationId: message.conversationId,
            parts: message.parts,
            createdAt: message.createdAt,
          })
          .from(message)
          .where(
            and(inArray(message.conversationId, conversationIds), eq(message.role, "assistant")),
          )
          .orderBy(message.conversationId, desc(message.createdAt), desc(message.id)),
  ]);
  const lastSent = new Map(sent.map((row) => [row.conversationId, row]));
  return rows.map(({ conversationId, ...row }) => {
    const last = lastSent.get(conversationId);
    return {
      ...row,
      turnStatus: statuses.get(row.id) ?? null,
      lastMessage: last ? { text: searchTextOf(last.parts), at: last.createdAt } : null,
    };
  });
}

/** One of the user's Bots with its Conversation's id, or `undefined` when it isn't theirs. */
export async function findBot(db: Database | Transaction, userId: string, botId: string) {
  const [row] = await db
    .select({ ...botColumns, conversationId: bot.conversationId })
    .from(bot)
    .where(and(eq(bot.id, botId), eq(bot.userId, userId)));
  return row;
}

/** A Bot Conversation's Messages, oldest first. They are only ever appended, so there are no Branches. */
export async function botMessages(
  db: Database | Transaction,
  conversationId: string,
): Promise<BotMessage[]> {
  const rows = await db
    .select({
      id: message.id,
      role: message.role,
      parts: message.parts,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt), asc(message.id));
  return rows.map(toBotMessage);
}

/**
 * The `bot` plugin's part of `sdk.deleteUser`: the user's Bot Conversations, through the core's
 * delete, and their Bots with them by cascade. Nothing is left for after the commit but its hooks.
 */
export const botUserDelete: UserDeleteHooks<() => Promise<void>> = {
  before: async (sdk, { userId, tx }) => {
    const { afterCommit } = await deleteConversations(sdk, tx, {
      where: eq(conversation.kind, botKind),
      userId,
      mute: true,
    });
    return afterCommit;
  },
  after: async (_sdk, { collected }) => {
    await collected();
  },
};

/** What the `bot` plugin adds to a user's export: each Bot with its Conversation's Messages. */
export type BotExport = { bots: (Bot & { messages: BotMessage[] })[] };

/** The `bot` plugin's part of `sdk.exportUser`, read in the export's snapshot `tx`. */
export async function exportBots(tx: Transaction, userId: string): Promise<BotExport> {
  const rows = await tx
    .select({ ...botColumns, conversationId: bot.conversationId })
    .from(bot)
    .where(eq(bot.userId, userId))
    .orderBy(asc(bot.createdAt), asc(bot.id));
  const messages = rows.length
    ? await tx
        .select({
          conversationId: message.conversationId,
          id: message.id,
          role: message.role,
          parts: message.parts,
          createdAt: message.createdAt,
        })
        .from(message)
        .where(
          inArray(
            message.conversationId,
            rows.map((row) => row.conversationId),
          ),
        )
        .orderBy(asc(message.createdAt), asc(message.id))
    : [];
  const byConversation = new Map<string, BotMessage[]>();
  for (const sent of messages) {
    const list = byConversation.get(sent.conversationId) ?? [];
    list.push(toBotMessage(sent));
    byConversation.set(sent.conversationId, list);
  }
  return {
    bots: rows.map(({ conversationId, ...row }) => ({
      ...row,
      messages: byConversation.get(conversationId) ?? [],
    })),
  };
}
