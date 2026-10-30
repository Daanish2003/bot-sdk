import { and, asc, eq, isNull, ne } from "drizzle-orm";

import { deleteConversations } from "../../chat/delete-conversations";
import { botRoomMember, botTrigger, conversation } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import { rpcError } from "../../rpc-error";
import {
  findBot,
  findRoom,
  hintChanged,
  oneBotRoom,
  recordBotChange,
  roomOf,
} from "../conversation";
import {
  lockConversationsInOrder,
  oneToOnesOf,
  runningTurnOf,
  skipWaiting,
  waitingIn,
} from "../triggers";
import { discardUnstarted } from "./pause";
import { cancelTurn } from "./turn";

/*
 * Managing a Room (spec #1055): rename it, add and remove Bots, change the lead, delete it. Each
 * checks that the Room is the user's, then works under the Conversation's row lock, as a send does.
 */

type Member = NonNullable<Awaited<ReturnType<typeof roomOf>>>["members"][number];

/** Runs `change` on the user's Room `conversationId`, in a transaction under its row lock. */
async function inRoom<T>(
  deps: BotSdkContext,
  userId: string,
  conversationId: string,
  change: (tx: Transaction, members: Member[], now: Date) => Promise<T>,
): Promise<T> {
  await findRoom(deps.db, userId, conversationId);
  const result = await deps.db.transaction(async (tx) => {
    await lockRoom(tx, conversationId);
    const room = await roomOf(tx, conversationId);
    if (!room) throw rpcError("NOT_FOUND", "error.roomNotFound", "Room not found");
    return change(tx, room.members, deps.clock());
  });
  deps.runner.wake();
  await hintChanged(deps, conversationId);
  return result;
}

/**
 * Takes the row lock of Room `conversationId` and of its members' 1:1 Conversations, in id order
 * (`lockConversationsInOrder`): a member's Room Turn that a change here cancels writes its 1:1 too.
 */
async function lockRoom(tx: Transaction, conversationId: string) {
  const members = await tx
    .select({ botId: botRoomMember.botId })
    .from(botRoomMember)
    .where(eq(botRoomMember.conversationId, conversationId));
  await lockConversationsInOrder(tx, [
    conversationId,
    ...(await oneToOnesOf(
      tx,
      members.map((member) => member.botId),
    )),
  ]);
}

/**
 * Makes the earliest member the lead when the Room has none (its lead's Bot was deleted, or the lead
 * was removed), in `tx`. `members` are in the order they joined.
 */
async function ensureLead(tx: Transaction, conversationId: string, members: Member[]) {
  const first = members[0];
  if (!first || members.some((member) => member.lead)) return;
  await tx
    .update(botRoomMember)
    .set({ lead: true })
    .where(
      and(eq(botRoomMember.conversationId, conversationId), eq(botRoomMember.botId, first.botId)),
    );
}

/** Stops Bot `owner.botId` in the Room, in `tx`: what waits for it is skipped and its running Turn there is cancelled. */
async function stopInRoom(
  deps: BotSdkContext,
  tx: Transaction,
  owner: { botId: string; conversationId: string },
  now: Date,
) {
  // Skipped before the Stop, so the Turn it ends finds the line empty and none follows it.
  await skipWaiting(tx, owner, "cancelled", now);
  const running = await runningTurnOf(tx, owner);
  if (running && (await cancelTurn(deps, tx, running, "stop"))) {
    await discardUnstarted(tx, running, "cancelled", now);
  }
}

/** Renames the user's Room. A Room with one Bot left can't be renamed. */
export async function renameRoom(
  deps: BotSdkContext,
  userId: string,
  { conversationId, name }: { conversationId: string; name: string },
): Promise<void> {
  await inRoom(deps, userId, conversationId, async (tx, members, now) => {
    if (members.length < 2) throw oneBotRoom();
    await tx.update(conversation).set({ title: name }).where(eq(conversation.id, conversationId));
    await recordBotChange(tx, { conversationId }, "bot", members[0]!.botId, now);
  });
}

/**
 * Adds the user's Bot `botId` to their Room, joining last. It sees the Room's history on its first
 * Turn. A Bot whose name matches a member's, in any case, is refused.
 */
export async function addRoomMember(
  deps: BotSdkContext,
  userId: string,
  { conversationId, botId }: { conversationId: string; botId: string },
): Promise<void> {
  await inRoom(deps, userId, conversationId, async (tx, members, now) => {
    const found = await findBot(tx, userId, botId);
    if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
    const name = found.name.toLowerCase();
    if (members.some((member) => member.botId === found.id || member.name.toLowerCase() === name)) {
      throw rpcError("BAD_REQUEST", "error.roomNameClash", "Two Bots in a Room share a name");
    }
    await tx.insert(botRoomMember).values({ conversationId, botId: found.id, joinedAt: now });
    await ensureLead(tx, conversationId, members);
    await recordBotChange(tx, { conversationId }, "bot", found.id, now);
  });
}

/**
 * Removes Bot `botId` from the user's Room: its waiting Triggers there are skipped and its running
 * Turn there is cancelled. Refused when two members are left. When the lead goes, the earliest
 * remaining member leads.
 */
export async function removeRoomMember(
  deps: BotSdkContext,
  userId: string,
  { conversationId, botId }: { conversationId: string; botId: string },
): Promise<void> {
  await inRoom(deps, userId, conversationId, async (tx, members, now) => {
    if (!members.some((member) => member.botId === botId)) {
      throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
    }
    if (members.length < 2) throw oneBotRoom();
    if (members.length === 2) {
      throw rpcError("BAD_REQUEST", "error.roomTooFewBots", "A Room needs at least two Bots");
    }
    await stopInRoom(deps, tx, { botId, conversationId }, now);
    await tx
      .delete(botRoomMember)
      .where(and(eq(botRoomMember.conversationId, conversationId), eq(botRoomMember.botId, botId)));
    await ensureLead(
      tx,
      conversationId,
      members.filter((member) => member.botId !== botId),
    );
    await recordBotChange(tx, { conversationId }, "bot", botId, now);
  });
}

/** Makes member `botId` the lead of the user's Room. Only the user changes the lead. */
export async function setRoomLead(
  deps: BotSdkContext,
  userId: string,
  { conversationId, botId }: { conversationId: string; botId: string },
): Promise<void> {
  await inRoom(deps, userId, conversationId, async (tx, members, now) => {
    if (!members.some((member) => member.botId === botId)) {
      throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
    }
    if (members.length < 2) throw oneBotRoom();
    const inThisRoom = eq(botRoomMember.conversationId, conversationId);
    // One lead per Room: the old one steps down first.
    await tx
      .update(botRoomMember)
      .set({ lead: false })
      .where(and(inThisRoom, ne(botRoomMember.botId, botId)));
    await tx
      .update(botRoomMember)
      .set({ lead: true })
      .where(and(inThisRoom, eq(botRoomMember.botId, botId)));
    await recordBotChange(tx, { conversationId }, "bot", botId, now);
  });
}

/**
 * Stops the user's Room (spec #1055), in one transaction under its row lock: the handoffs waiting
 * in it are skipped as cancelled, then each member's running Turn there stops as a 1:1 Stop stops
 * it, taking what else waits for it. Helpers and the Bots' Turns elsewhere go on.
 */
export async function stopRoom(
  deps: BotSdkContext,
  userId: string,
  conversationId: string,
): Promise<void> {
  await inRoom(deps, userId, conversationId, async (tx, members, now) => {
    // Skipped before the Stops, so no Turn that ends takes one.
    await tx
      .update(botTrigger)
      .set({ skippedAt: now, skipReason: "cancelled" })
      .where(
        and(
          eq(botTrigger.conversationId, conversationId),
          eq(botTrigger.source, "agent"),
          isNull(botTrigger.turnId),
          isNull(botTrigger.skippedAt),
        ),
      );
    for (const { botId } of members) {
      const owner = { botId, conversationId };
      const running = await runningTurnOf(tx, owner);
      if (!running) continue;
      await tx.update(botTrigger).set({ turnId: running }).where(waitingIn(owner));
      await cancelTurn(deps, tx, running, "stop");
    }
  });
}

/**
 * Deletes the user's Room with its Messages: every member's running Turn there is cancelled and
 * what waits is skipped first. The Bots keep their Memory.
 */
export async function deleteRoom(
  deps: BotSdkContext,
  userId: string,
  conversationId: string,
): Promise<void> {
  await findRoom(deps.db, userId, conversationId);
  const afterCommit = await deps.db.transaction(async (tx) => {
    await lockRoom(tx, conversationId);
    const members = await tx
      .select({ botId: botRoomMember.botId })
      .from(botRoomMember)
      .where(eq(botRoomMember.conversationId, conversationId))
      .orderBy(asc(botRoomMember.joinedAt));
    const now = deps.clock();
    for (const { botId } of members) await stopInRoom(deps, tx, { botId, conversationId }, now);
    const deleted = await deleteConversations(deps, tx, {
      where: eq(conversation.id, conversationId),
      userId,
      announce: true,
    });
    return deleted.afterCommit;
  });
  await afterCommit();
  deps.runner.wake();
}
