import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { deleteConversations } from "../../../core/server/chat/delete-conversations";
import {
  bot,
  botSecret,
  botTrigger,
  botTurn,
  conversation,
  message,
  type MessageRow,
} from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { Transaction, UserDeleteHooks } from "../../../core/server/plugin";
import { searchTextOf } from "../../../core/shared/message-parts";
import {
  botMessagePartsSchema,
  type RichControl,
  type RichControlKind,
} from "../shared/rich-control";
import { type Reactions, storedReactionsSchema } from "../shared/reaction";
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

/**
 * A Bot Conversation Message's stored parts: one base `text` part, and the IANA `timeZone` the
 * user sent it from, when they sent one.
 */
export function textParts(text: string, timeZone?: string): MessageRow["parts"] {
  return { schemaVersion: 1, parts: [{ type: "text", text }], ...(timeZone && { timeZone }) };
}

/**
 * A Bot Message's stored parts with its Rich control (spec #761): the text as its `text` part, so
 * the Conversation reads it, then the control. The column is typed as the assistant's parts union
 * until the row types are composed from the plugins, so the bot plugin's `control` part is cast in
 * here.
 */
export function controlParts(
  text: string,
  control: RichControl,
  previous?: MessageRow["parts"],
): MessageRow["parts"] {
  // A Message's emojis live beside its parts, so a control changing its state keeps them.
  const reactions = previous && (previous as { reactions?: unknown }).reactions;
  return {
    ...(reactions ? { reactions } : {}),
    schemaVersion: 1,
    parts: [
      { type: "text", text },
      { type: "control", control },
    ],
  } as unknown as MessageRow["parts"];
}

/**
 * What a Message's parts contain when they hold a control matching `control`: a jsonb `@>` value
 * for finding the Messages that hold a given card.
 */
export function holdingControl(control: { kind: RichControlKind } & Record<string, unknown>) {
  return { parts: [{ type: "control", control }] };
}

/**
 * The Rich control a Message's parts hold, if any: of kind `kind` when given. Parts that aren't a
 * Bot Message's (two controls, say) hold none.
 */
export function controlOf(parts: MessageRow["parts"]): RichControl | undefined;
export function controlOf<Kind extends RichControlKind>(
  parts: MessageRow["parts"],
  kind: Kind,
): Extract<RichControl, { kind: Kind }> | undefined;
export function controlOf(parts: MessageRow["parts"], kind?: RichControlKind) {
  const read = botMessagePartsSchema.safeParse(parts);
  if (!read.success) return undefined;
  for (const part of read.data.parts)
    if (part.type === "control" && (!kind || part.control.kind === kind)) return part.control;
  return undefined;
}

/** The emojis on a Message's parts (spec #761): at most one from the user and one from the Bot. */
export function reactionsOf(parts: MessageRow["parts"]): Reactions | undefined {
  const read = storedReactionsSchema.safeParse((parts as { reactions?: unknown }).reactions);
  if (!read.success) return undefined;
  const { user, bot } = read.data;
  const reactions: Reactions = {
    ...(user && { user: { emoji: user.emoji, at: new Date(user.at) } }),
    ...(bot && { bot: { emoji: bot.emoji, at: new Date(bot.at) } }),
  };
  return user || bot ? reactions : undefined;
}

/**
 * Puts `emoji` on Message `messageId` as `side`'s one reaction, replacing that side's earlier one,
 * or takes it off when `emoji` is null. It is state on the Message, with no schema of its own, and
 * is written in place so a concurrent change to the Message's other parts is not lost. The caller
 * records the change.
 */
export async function setReaction(
  tx: Transaction,
  messageId: string,
  side: "user" | "bot",
  emoji: string | null,
  at: Date,
): Promise<void> {
  const without = sql`coalesce(${message.parts}->'reactions', '{}'::jsonb) - ${side}::text`;
  const reactions =
    emoji === null
      ? without
      : sql`(${without}) || ${JSON.stringify({ [side]: { emoji, at } })}::jsonb`;
  await tx
    .update(message)
    .set({ parts: sql`jsonb_set(${message.parts}, '{reactions}', ${reactions})` })
    .where(eq(message.id, messageId));
}

/** A Message row as the client sees it, with its Rich control when it has one. */
export function toBotMessage(
  row: Pick<MessageRow, "id" | "role" | "parts" | "createdAt">,
): BotMessage {
  const control = controlOf(row.parts);
  const reactions = reactionsOf(row.parts);
  return {
    id: row.id,
    role: row.role,
    text: searchTextOf(row.parts),
    createdAt: row.createdAt,
    ...(control && { control }),
    ...(reactions && { reactions }),
    ...(row.parts.channel && { channel: row.parts.channel }),
  };
}

/**
 * Creates a Bot and its empty Conversation (kind `bot`, no title) in one transaction, at `now`:
 * a rebuild of the user's Computer before then is no news to it.
 */
export async function createBot(
  db: Database,
  userId: string,
  { name, model }: { name: string; model: string },
  now: Date,
): Promise<Bot> {
  return db.transaction(async (tx) => {
    const conversationId = uuidv7();
    await tx.insert(conversation).values({ id: conversationId, userId, kind: botKind });
    const [row] = await tx
      .insert(bot)
      .values({ id: uuidv7(), userId, conversationId, name, model, computerRebuildSeenAt: now })
      .returning(botColumns);
    if (!row) throw new Error("Inserting the Bot returned no row");
    return row;
  });
}

/**
 * How much later than the Computer's last activity a running Turn may be stamped and still hold
 * it: the Turn's start and the activity are stamped by different clocks (#558).
 */
export const turnStartSkewMs = 30_000;

/**
 * Whether a Turn of one of the user's Bots is running and started before `lastActiveAt`, the
 * Computer's last activity, give or take `turnStartSkewMs`, so it may still use the Computer:
 * `bot`'s busy check (#508). A Turn that started later hasn't used it yet.
 */
export async function hasTurnUsingComputer(
  db: Database,
  userId: string,
  lastActiveAt: Date,
): Promise<boolean> {
  const [running] = await db
    .select({ id: botTurn.id })
    .from(botTurn)
    .innerJoin(bot, eq(bot.id, botTurn.botId))
    .where(
      and(
        eq(bot.userId, userId),
        eq(botTurn.status, "running"),
        lt(botTurn.startedAt, new Date(lastActiveAt.getTime() + turnStartSkewMs)),
      ),
    )
    .limit(1);
  return running !== undefined;
}

/**
 * Whether the user has a Bot, read under a lock that the user's delete waits for: `bot`'s owner
 * check, so a Turn racing that delete creates no Computer (#554).
 */
export async function userHasBot(tx: Transaction, userId: string): Promise<boolean> {
  const [found] = await tx
    .select({ id: bot.id })
    .from(bot)
    .where(eq(bot.userId, userId))
    .limit(1)
    .for("key share");
  return found !== undefined;
}

/**
 * The latest rebuild of the user's Computer the Bot was told of, or its creation (null for a Bot
 * from before the column, or one deleted meanwhile).
 */
export async function computerRebuildSeenAt(db: Database, botId: string): Promise<Date | null> {
  const [row] = await db
    .select({ seenAt: bot.computerRebuildSeenAt })
    .from(bot)
    .where(eq(bot.id, botId));
  return row?.seenAt ?? null;
}

/** Records that the Bot was told of the Computer's rebuild at `rebuiltAt`. */
export async function markComputerRebuildSeen(
  db: Database,
  botId: string,
  rebuiltAt: Date,
): Promise<void> {
  await db
    .update(bot)
    .set({ computerRebuildSeenAt: rebuiltAt })
    .where(
      and(
        eq(bot.id, botId),
        or(isNull(bot.computerRebuildSeenAt), lt(bot.computerRebuildSeenAt, rebuiltAt)),
      ),
    );
}

/** The longest a Turn may run; past it, it ends `error` with `timed_out`. */
export const turnTimeLimitMs = 5 * 60_000;

/** The status of each Bot's latest Turn; a Bot with no Turn has no entry. */
async function latestTurnStatuses(db: Database | Transaction, botIds: string[]) {
  if (botIds.length === 0) return new Map<string, BotTurnStatus>();
  const rows = await db
    .selectDistinctOn([botTurn.botId], {
      botId: botTurn.botId,
      status: botTurn.status,
    })
    .from(botTurn)
    .where(inArray(botTurn.botId, botIds))
    .orderBy(botTurn.botId, desc(botTurn.startedAt), desc(botTurn.id));
  return new Map(rows.map((row): [string, BotTurnStatus] => [row.botId, row.status]));
}

/** The latest Turn's status of one Bot, `null` before its first Turn. */
export async function latestTurnStatus(db: Database | Transaction, botId: string) {
  return (await latestTurnStatuses(db, [botId])).get(botId) ?? null;
}

/**
 * The status of the Turn that took the user's last Message, found by its Trigger's ID (the
 * Message's): `null` before their first and while it waits in the Conversation queue. A later
 * Routine or Check-in run leaves it as it is.
 */
export async function userTurnStatus(
  db: Database | Transaction,
  messages: BotMessage[],
): Promise<BotTurnStatus | null> {
  const last = messages.filter((sent) => sent.role === "user").at(-1);
  if (!last) return null;
  const [row] = await db
    .select({ status: botTurn.status })
    .from(botTrigger)
    .innerJoin(botTurn, eq(botTurn.id, botTrigger.turnId))
    .where(eq(botTrigger.id, last.id));
  return row?.status ?? null;
}

/**
 * The user's Bots, the newest activity in their Conversation first, each with its last sent Message
 * and its latest Turn's status.
 */
export async function listBots(db: Database, userId: string): Promise<ListedBot[]> {
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

/**
 * A Bot Conversation's Messages, oldest first, or those from `since` on. They are only ever appended,
 * so there are no Branches.
 */
export async function botMessages(
  db: Database | Transaction,
  conversationId: string,
  since?: Date,
): Promise<BotMessage[]> {
  const rows = await db
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
        since ? gte(message.createdAt, since) : undefined,
      ),
    )
    .orderBy(asc(message.createdAt), asc(message.id));
  return rows.map(toBotMessage);
}

/**
 * The IANA time zone the Conversation's newest user Message was sent from, or `undefined` when it
 * carried none (or there is no user Message yet). Routines and Check-ins take their zone from it.
 */
export async function newestTimeZone(
  db: Database | Transaction,
  conversationId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ parts: message.parts })
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.role, "user")))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1);
  return row?.parts.timeZone;
}

/**
 * The `bot` plugin's part of `sdk.deleteUser`: the user's Bot Conversations, through the core's
 * delete, and their Bots with them by cascade. Nothing is left for after the commit but its hooks.
 */
export const botUserDelete: UserDeleteHooks<() => Promise<void>> = {
  before: async (sdk, { userId, tx }) => {
    // The user's Secrets are theirs, not a Bot's, so no cascade reaches them.
    await tx.delete(botSecret).where(eq(botSecret.userId, userId));
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
