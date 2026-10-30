import type { Room, RoomMember } from "@botsdk/client/bot/contract";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { bot, botRoomMember, conversation, message } from "../../storage";
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
  for (const { conversationId, ...member } of rows) {
    const members = byRoom.get(conversationId) ?? [];
    members.push(member);
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
