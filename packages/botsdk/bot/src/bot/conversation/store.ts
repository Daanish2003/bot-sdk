import type { Bot, ListedBot } from "@botsdk/client/bot/contract";
import type { Reactions } from "@botsdk/client/bot/reaction";
import {
  type BotMessageParts,
  botMessagePartsSchema,
  type RichControl,
  type RichControlKind,
} from "@botsdk/client/bot/rich-control";
import type { BotMessage, BotTurnStatus } from "@botsdk/client/bot/turn";
import { searchTextOf } from "@botsdk/client/message-parts";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { deleteConversations } from "../../chat/delete-conversations";
import {
  bot,
  botRoomMember,
  botSecret,
  customRule,
  notificationSettings,
  pushSubscription,
  botTrigger,
  botTurn,
  conversation,
  message,
  type MessageRow,
} from "../../storage";
import type { Database } from "../../storage";
import { uuidv7 } from "../../lib/uuidv7";
import { appendMessage } from "../../chat/message-tree";
import type { BotSdkContext, Transaction, UserDeleteHooks } from "../../plugin";

/** The `kind` of every Bot's Conversation: the plugin's id. */
export const botKind = "bot";

const botColumns = {
  id: bot.id,
  name: bot.name,
  model: bot.model,
  createdAt: bot.createdAt,
  pausedAt: bot.pausedAt,
};

export type { Bot, BotWithStatus, ListedBot } from "@botsdk/client/bot/contract";

export type { BotMessage };

/**
 * A Bot Conversation Message's stored parts: one base `text` part, and the IANA `timeZone` the
 * user sent it from, when they sent one.
 */
export function textParts(text: string, timeZone?: string, urgent?: boolean): BotMessageParts {
  return {
    ...(urgent && { urgent }),
    schemaVersion: 1,
    parts: [{ type: "text", text }],
    ...(timeZone && { timeZone }),
  };
}

/**
 * A Bot Message's stored parts with its Rich control (spec #761): the text as its `text` part, so
 * the Conversation reads it, then the control.
 */
export function controlParts(
  text: string,
  control: RichControl,
  previous?: MessageRow["parts"],
  urgent?: boolean,
): BotMessageParts {
  // A Message's emojis, urgent mark and handoff live beside its parts, so a control changing its
  // state keeps them.
  const reactions = previous && storedReactionsOf(previous);
  const marked = urgent || (previous && urgentOf(previous));
  const handoff = previous && handoffOf(previous);
  return {
    ...(reactions && { reactions }),
    ...(marked && { urgent: true as const }),
    ...(handoff && { handoff }),
    schemaVersion: 1,
    parts: [
      { type: "text", text },
      { type: "control", control },
    ],
  };
}

/**
 * A Bot Message's stored parts are read by the Bot's schema one field at a time, so a field that
 * doesn't read (two controls, say) costs only that field: the parts here, the rest below.
 */
const botPartsOnly = botMessagePartsSchema.pick({ schemaVersion: true, parts: true });
const botFields = botMessagePartsSchema.shape;

const storedReactionsOf = (parts: MessageRow["parts"]) =>
  botFields.reactions.safeParse(parts.reactions).data;

/** The Channel besides web a Bot Message came in or also went out on, if any (spec #761). */
export const channelOf = (parts: MessageRow["parts"]) =>
  botFields.channel.safeParse(parts.channel).data;

/** Whether the Bot marked a Message urgent (spec #1024). */
export const urgentOf = (parts: MessageRow["parts"]) =>
  botFields.urgent.safeParse(parts.urgent).data === true;

/** The handoff a Bot's Room Message made, if any (spec #1055). */
export const handoffOf = (parts: MessageRow["parts"]) =>
  botFields.handoff.safeParse(parts.handoff).data;

/** The subject of an emailed user's Message, which the Bot's emailed reply answers (spec #761). */
export const subjectOf = (parts: MessageRow["parts"]) =>
  botFields.subject.safeParse(parts.subject).data;

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
  const read = botPartsOnly.safeParse(parts);
  if (!read.success) return undefined;
  for (const part of read.data.parts)
    if (part.type === "control" && (!kind || part.control.kind === kind)) return part.control;
  return undefined;
}

/** The emojis on a Message's parts (spec #761): at most one from the user and one from the Bot. */
export function reactionsOf(parts: MessageRow["parts"]): Reactions | undefined {
  const stored = storedReactionsOf(parts);
  if (!stored) return undefined;
  const { user, bot } = stored;
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

/**
 * Saves a Message Bot `botId` sends (a SendToUser Message, or a card it posts) in Conversation
 * `conversationId`, as its author (spec #1055), in `tx`, which then holds the Conversation's row lock, and hands it to the `channel` plugin, when the Host has it, to
 * deliver on the user's other Channels too (spec #761). `turnId` is the Turn that sent it, or
 * `null` when no Turn did (a Helper). Returns the saved Message's id.
 */
export async function appendBotMessage(
  deps: BotSdkContext,
  tx: Transaction,
  { botId, conversationId }: { botId: string; conversationId: string },
  { parts, createdAt, turnId }: Pick<MessageRow, "parts" | "createdAt"> & { turnId: string | null },
): Promise<string> {
  const row = await appendMessage(tx, conversationId, {
    role: "assistant",
    authorBotId: botId,
    parts,
    status: "complete",
    createdAt,
  });
  // A no-op with no email adapter in the channels slot.
  await deps.channels.deliverIn(tx, {
    botId,
    conversationId,
    messageId: row.id,
    turnId,
    urgent: urgentOf(parts),
  });
  return row.id;
}

/** A Message row as the client sees it, with its Rich control when it has one. */
export function toBotMessage(
  row: Pick<MessageRow, "id" | "role" | "parts" | "createdAt"> &
    Partial<Pick<MessageRow, "authorBotId">>,
): BotMessage {
  const control = controlOf(row.parts);
  const reactions = reactionsOf(row.parts);
  const channel = channelOf(row.parts);
  const urgent = urgentOf(row.parts);
  const handoff = handoffOf(row.parts);
  return {
    id: row.id,
    role: row.role,
    text: searchTextOf(row.parts),
    createdAt: row.createdAt,
    ...(control && { control }),
    ...(reactions && { reactions }),
    ...(channel && { channel }),
    ...(urgent && { urgent }),
    ...(row.authorBotId && { authorBotId: row.authorBotId }),
    ...(handoff && { handoff }),
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

/** The Model of the user's newest Bot, for the `models` plugin's default (`addRecentModelSource`). */
export async function newestBotModel(db: Database, userId: string): Promise<string | undefined> {
  const [newest] = await db
    .select({ model: bot.model })
    .from(bot)
    .where(eq(bot.userId, userId))
    .orderBy(desc(bot.createdAt), desc(bot.id))
    .limit(1);
  return newest?.model;
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
      authorBotId: message.authorBotId,
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
 * The `bot` plugin's part of `sdk.users.delete`: the user's Bot Conversations, through the core's
 * delete, and their Bots with them by cascade. Nothing is left for after the commit but its hooks.
 */
export const botUserDelete: UserDeleteHooks<() => Promise<void>> = {
  before: async (sdk, { userId, tx }) => {
    // The user's Secrets, Custom Rules, notification settings and push subscriptions are theirs,
    // not a Bot's, so no cascade reaches them.
    await tx.delete(botSecret).where(eq(botSecret.userId, userId));
    await tx.delete(customRule).where(eq(customRule.userId, userId));
    await tx.delete(notificationSettings).where(eq(notificationSettings.userId, userId));
    await tx.delete(pushSubscription).where(eq(pushSubscription.userId, userId));
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

/** One of the user's Rooms in their export (spec #1055): its members, and its Messages with authors. */
export type RoomExport = {
  conversationId: string;
  name: string;
  createdAt: Date;
  members: { botId: string; name: string; lead: boolean }[];
  messages: BotMessage[];
};

/**
 * What the `bot` plugin adds to a user's export: each Bot with its Conversation's Messages, and
 * each Room with its own.
 */
export type BotExport = { bots: (Bot & { messages: BotMessage[] })[]; rooms: RoomExport[] };

/** The `bot` plugin's part of `sdk.users.export`, read in the export's snapshot `tx`. */
export async function exportBots(tx: Transaction, userId: string): Promise<BotExport> {
  const rows = await tx
    .select({ ...botColumns, conversationId: bot.conversationId })
    .from(bot)
    .where(eq(bot.userId, userId))
    .orderBy(asc(bot.createdAt), asc(bot.id));
  const rooms = await tx
    .selectDistinct({
      conversationId: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
    })
    .from(conversation)
    .innerJoin(botRoomMember, eq(botRoomMember.conversationId, conversation.id))
    .where(and(eq(conversation.userId, userId), eq(conversation.kind, botKind)))
    .orderBy(asc(conversation.createdAt), asc(conversation.id));
  const roomIds = rooms.map((room) => room.conversationId);
  const members = roomIds.length
    ? await tx
        .select({
          conversationId: botRoomMember.conversationId,
          botId: botRoomMember.botId,
          name: bot.name,
          lead: botRoomMember.lead,
        })
        .from(botRoomMember)
        .innerJoin(bot, eq(bot.id, botRoomMember.botId))
        .where(inArray(botRoomMember.conversationId, roomIds))
        .orderBy(asc(botRoomMember.joinedAt), asc(botRoomMember.botId))
    : [];
  const conversationIds = [...rows.map((row) => row.conversationId), ...roomIds];
  const messages = conversationIds.length
    ? await tx
        .select({
          conversationId: message.conversationId,
          id: message.id,
          role: message.role,
          parts: message.parts,
          createdAt: message.createdAt,
          authorBotId: message.authorBotId,
        })
        .from(message)
        .where(inArray(message.conversationId, conversationIds))
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
    rooms: rooms.map(({ title, ...room }) => ({
      ...room,
      name: title ?? "",
      members: members
        .filter((member) => member.conversationId === room.conversationId)
        .map(({ conversationId: _room, ...member }) => member),
      messages: byConversation.get(room.conversationId) ?? [],
    })),
  };
}
