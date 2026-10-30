import type { Room, RoomMember, RoomMemberStatus } from "@botsdk/client/bot/contract";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import {
  bot,
  botHelper,
  botReview,
  botRoomMember,
  botTrigger,
  botTurn,
  conversation,
  message,
} from "../../storage";
import type { Database } from "../../storage";
import type { Transaction } from "../../plugin";
import { uuidv7 } from "../../lib/uuidv7";
import { rpcError } from "../../rpc-error";
import { botKind } from "./store";

/*
 * Rooms (spec #1055): a Conversation of kind `bot` that the user shares with two or more of their
 * Bots, named by its title. It counts as a Room because it has member rows; a Bot's 1:1
 * Conversation is still the one its Bot row points at.
 */

/** A Room left with one Bot (its others were deleted) allows only adding a Bot or deleting it. */
export const oneBotRoom = () =>
  rpcError("BAD_REQUEST", "error.roomOneBot", "This Room has one Bot left: add a Bot or delete it");

/**
 * SQL: the Conversation where what Bot `botId` started in Turn `turnId` lands (spec #1055): a
 * Helper's report and its Approval requests. That is the Turn's Conversation, a Room included, as
 * long as the Bot is still in it; a Bot that left, or a Turn that is gone, lands in the Bot's 1:1
 * Conversation `oneToOne`, never in a Room it left.
 */
export function landsWhereStarted(turnId: SQLWrapper, botId: SQLWrapper, oneToOne: SQLWrapper) {
  return sql<string>`coalesce((select ${botTurn.conversationId} from ${botTurn} where ${botTurn.id} = ${turnId} and (${botTurn.conversationId} = ${oneToOne} or exists (select 1 from ${botRoomMember} where ${botRoomMember.conversationId} = ${botTurn.conversationId} and ${botRoomMember.botId} = ${botId}))), ${oneToOne})`;
}

/** SQL: the Conversation of Helper `helperId` of Bot `botId`, by `landsWhereStarted`; `helperId` is another table's column. */
const helperConversation = (helperId: SQLWrapper, botId: SQLWrapper, oneToOne: SQLWrapper) =>
  landsWhereStarted(
    sql`(select ${botHelper.startedByTurnId} from ${botHelper} where ${botHelper.id} = ${helperId})`,
    botId,
    oneToOne,
  );

/**
 * SQL: the Conversation where Auto-review `reviewId`'s Approval is asked: its Turn's, or its
 * Helper's (`helperConversation`), or the Bot's 1:1 Conversation `oneToOne`.
 */
export const reviewConversation = (
  review: { turnId: SQLWrapper; helperId: SQLWrapper; botId: SQLWrapper },
  oneToOne: SQLWrapper,
) =>
  sql<string>`coalesce((select ${botTurn.conversationId} from ${botTurn} where ${botTurn.id} = ${review.turnId}), ${helperConversation(review.helperId, review.botId, oneToOne)})`;

/**
 * The Bot of Auto-review `reviewId` and the Conversation its Approval is asked in (`reviewConversation`),
 * where its changes are recorded; or `undefined` when it is gone.
 */
export async function reviewOwnerOf(
  db: Database | Transaction,
  reviewId: string,
): Promise<{ botId: string; conversationId: string } | undefined> {
  const [owner] = await db
    .select({ botId: bot.id, conversationId: reviewConversation(botReview, bot.conversationId) })
    .from(botReview)
    .innerJoin(bot, eq(bot.id, botReview.botId))
    .where(eq(botReview.id, reviewId));
  return owner;
}

/**
 * The Bot of Helper `helperId` and the Conversation it reports into (`helperConversation`), where its
 * changes are recorded; or `undefined` when it is gone.
 */
export async function helperOwnerOf(
  db: Database | Transaction,
  helperId: string,
): Promise<{ botId: string; conversationId: string } | undefined> {
  const [owner] = await db
    .select({
      botId: bot.id,
      conversationId: landsWhereStarted(
        botHelper.startedByTurnId,
        botHelper.botId,
        bot.conversationId,
      ),
    })
    .from(botHelper)
    .innerJoin(bot, eq(bot.id, botHelper.botId))
    .where(eq(botHelper.id, helperId));
  return owner;
}

/** The members of the Rooms `conversationIds`, in the order they joined, by Room. */
async function membersOf(
  db: Database | Transaction,
  conversationIds: string[],
): Promise<Map<string, RoomMember[]>> {
  const byRoom = new Map<string, RoomMember[]>();
  if (conversationIds.length === 0) return byRoom;
  const rows = await db
    .select({
      conversationId: botRoomMember.conversationId,
      botId: botRoomMember.botId,
      name: bot.name,
      lead: botRoomMember.lead,
      pausedAt: bot.pausedAt,
    })
    .from(botRoomMember)
    .innerJoin(bot, eq(bot.id, botRoomMember.botId))
    .where(inArray(botRoomMember.conversationId, conversationIds))
    .orderBy(asc(botRoomMember.joinedAt), asc(botRoomMember.botId));
  // Who runs a Turn, and who has a Trigger waiting, in each Room: keyed `<conversation>:<bot>`.
  const [running, waiting] = await Promise.all([
    db
      .select({ conversationId: botTurn.conversationId, botId: botTurn.botId })
      .from(botTurn)
      .where(and(inArray(botTurn.conversationId, conversationIds), eq(botTurn.status, "running"))),
    db
      .selectDistinct({ conversationId: botTrigger.conversationId, botId: botTrigger.botId })
      .from(botTrigger)
      .where(
        and(
          inArray(botTrigger.conversationId, conversationIds),
          isNull(botTrigger.turnId),
          isNull(botTrigger.skippedAt),
        ),
      ),
  ]);
  const keyOf = (row: { conversationId: string; botId: string }) =>
    `${row.conversationId}:${row.botId}`;
  const working = new Set(running.map(keyOf));
  const queued = new Set(waiting.map(keyOf));
  for (const { conversationId, ...member } of rows) {
    const members = byRoom.get(conversationId) ?? [];
    const key = keyOf({ conversationId, botId: member.botId });
    const status: RoomMemberStatus | null = member.pausedAt
      ? "paused"
      : working.has(key)
        ? "working"
        : queued.has(key)
          ? "queued"
          : null;
    members.push({ ...member, status });
    byRoom.set(conversationId, members);
  }
  return byRoom;
}

/** The user's Rooms, the newest activity first; only Room `conversationId` when given. */
export async function listRooms(
  db: Database | Transaction,
  userId: string,
  conversationId?: string,
): Promise<Room[]> {
  const rows = await db
    .selectDistinct({
      conversationId: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      lastMessageAt: conversation.lastMessageAt,
    })
    .from(conversation)
    .innerJoin(botRoomMember, eq(botRoomMember.conversationId, conversation.id))
    .where(
      and(
        eq(conversation.userId, userId),
        eq(conversation.kind, botKind),
        conversationId ? eq(conversation.id, conversationId) : undefined,
      ),
    )
    .orderBy(desc(conversation.lastMessageAt), desc(conversation.id));
  const members = await membersOf(
    db,
    rows.map((row) => row.conversationId),
  );
  return rows.map(({ title, ...row }) => ({
    ...row,
    name: title ?? "",
    members: members.get(row.conversationId) ?? [],
  }));
}

/** The ids of the Rooms Bot `botId` is a member of, in id order: the order their locks are taken in. */
export async function roomIdsOf(db: Database | Transaction, botId: string): Promise<string[]> {
  const rows = await db
    .select({ id: botRoomMember.conversationId })
    .from(botRoomMember)
    .where(eq(botRoomMember.botId, botId))
    .orderBy(asc(botRoomMember.conversationId));
  return rows.map((row) => row.id);
}

/** The name of Room `conversationId`, or `null` when it isn't a Room (a Bot's 1:1 Conversation). */
export async function roomNameOf(
  db: Database | Transaction,
  conversationId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ title: conversation.title })
    .from(conversation)
    .innerJoin(botRoomMember, eq(botRoomMember.conversationId, conversation.id))
    .where(eq(conversation.id, conversationId))
    .limit(1);
  return row ? (row.title ?? "") : null;
}

/** Whether Conversation `conversationId` is one of the user's Rooms. */
export async function isRoomOf(
  db: Database | Transaction,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .innerJoin(botRoomMember, eq(botRoomMember.conversationId, conversation.id))
    .where(and(eq(conversation.id, conversationId), eq(conversation.userId, userId)))
    .limit(1);
  return row !== undefined;
}

/**
 * The user's Room `conversationId`. Another user's Conversation, or one that isn't a Room (a Bot's
 * 1:1 Conversation), is not found.
 */
export async function findRoom(
  db: Database | Transaction,
  userId: string,
  conversationId: string,
): Promise<Room> {
  const [room] = await listRooms(db, userId, conversationId);
  if (!room) throw rpcError("NOT_FOUND", "error.roomNotFound", "Room not found");
  return room;
}

/**
 * Creates a Room named `name` with the user's Bots `botIds`, the first the lead, at `now`. Fewer
 * than two Bots, another user's Bot, or two Bots of the same name (a mention names one) is refused.
 */
export async function createRoom(
  db: Database,
  userId: string,
  { name, botIds }: { name: string; botIds: string[] },
  now: Date,
): Promise<Room> {
  const ids = [...new Set(botIds.map((id) => id.toLowerCase()))];
  if (ids.length < 2) {
    throw rpcError("BAD_REQUEST", "error.roomTooFewBots", "A Room needs at least two Bots");
  }
  const owned = await db
    .select({ id: bot.id, name: bot.name })
    .from(bot)
    .where(and(eq(bot.userId, userId), inArray(bot.id, ids)));
  if (owned.length !== ids.length)
    throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const names = new Set(owned.map((row) => row.name.toLowerCase()));
  if (names.size !== owned.length) {
    throw rpcError("BAD_REQUEST", "error.roomNameClash", "Two Bots in a Room share a name");
  }
  const conversationId = uuidv7();
  await db.transaction(async (tx) => {
    await tx.insert(conversation).values({
      id: conversationId,
      userId,
      kind: botKind,
      title: name,
      lastMessageAt: now,
      createdAt: now,
    });
    // Joined a millisecond apart, so the members list in the order they were picked.
    await tx.insert(botRoomMember).values(
      ids.map((botId, index) => ({
        conversationId,
        botId,
        lead: index === 0,
        joinedAt: new Date(now.getTime() + index),
      })),
    );
  });
  return findRoom(db, userId, conversationId);
}

/** A Room as a Turn in it reads it: its name, and its members with their reset points. */
export type TurnRoom = {
  name: string;
  members: { botId: string; name: string; lead: boolean; resetAt: Date | null }[];
};

/** Conversation `conversationId` as a Room, in the order its members joined; `undefined` when it isn't one. */
export async function roomOf(
  db: Database | Transaction,
  conversationId: string,
): Promise<TurnRoom | undefined> {
  const rows = await db
    .select({
      title: conversation.title,
      botId: botRoomMember.botId,
      name: bot.name,
      lead: botRoomMember.lead,
      resetAt: botRoomMember.resetAt,
    })
    .from(botRoomMember)
    .innerJoin(bot, eq(bot.id, botRoomMember.botId))
    .innerJoin(conversation, eq(conversation.id, botRoomMember.conversationId))
    .where(eq(botRoomMember.conversationId, conversationId))
    .orderBy(asc(botRoomMember.joinedAt), asc(botRoomMember.botId));
  if (rows.length === 0) return undefined;
  return {
    name: rows[0]!.title ?? "",
    members: rows.map(({ title: _title, ...member }) => member),
  };
}

/**
 * The IANA zone of the newest Message the user sent that has one, in any of their Conversations:
 * a Room's composer sends none, so a Room Message keeps the zone the user last wrote from.
 */
export async function userTimeZone(
  db: Database | Transaction,
  userId: string,
): Promise<string | undefined> {
  const zone = sql<string>`${message.parts}->>'timeZone'`;
  const [row] = await db
    .select({ zone })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(and(eq(conversation.userId, userId), eq(message.role, "user"), isNotNull(zone)))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1);
  return row?.zone;
}

/**
 * The Bot that wrote a Message, as a join condition (spec #1055): its author, or, for a Message from
 * before authors were recorded, the Bot whose 1:1 Conversation it is in.
 */
export const authoredBy = () =>
  or(eq(bot.id, message.authorBotId), eq(bot.conversationId, message.conversationId));

/**
 * How a Message of Bot `botId` (named `name`) in Conversation `conversationId` reaches the user
 * outside the app (spec #1055): the title of its notification and where it opens. In a 1:1 Conversation
 * that is the Bot's name and its page; in a Room, the Room and the Bot's names, and the Room.
 */
export async function notificationOf(
  db: Database | Transaction,
  { botId, name, conversationId }: { botId: string; name: string; conversationId: string },
): Promise<{ title: string; path: string; room: boolean }> {
  const room = await roomNameOf(db, conversationId);
  return room === null
    ? { title: name, path: `/bots/${botId}`, room: false }
    : {
        title: room ? `${room} · ${name}` : name,
        path: `/bots/rooms/${conversationId}`,
        room: true,
      };
}
