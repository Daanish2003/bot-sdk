import { createRoomInput, roomInput, roomSendInput } from "@botsdk/client/bot/contract";

import { lastSeqOf } from "../chat/change-log";
import type { BotSdkContext } from "../plugin";
import { parseInput, type WithUser } from "../rpc-error";
import { botMessages, createRoom, findRoom, listRooms } from "./conversation";
import { sendToRoom } from "./turn";

/**
 * The `rooms` namespace's domain methods (spec #1055), taking the user's id as `bots` does. Each
 * checks that the Room is the user's: another user's is not found. A Room's thread is followed
 * with `conversations.changes`, as a Bot's is.
 */
export function roomsApi(sdk: BotSdkContext) {
  return {
    /** The user's Rooms, the newest activity first, each with its members, the lead marked. */
    list: async ({ userId }: { userId: string }) => listRooms(sdk.db, userId),

    /**
     * One of the user's Rooms, its Messages (each Bot Message with its author Bot), and `lastSeq`,
     * the cursor to follow its thread with `conversations.changes` from.
     */
    get: async ({ userId, ...rest }: WithUser<typeof roomInput>) => {
      const { conversationId } = parseInput(roomInput, rest);
      const room = await findRoom(sdk.db, userId, conversationId);
      // Read before the thread, so no change committed meanwhile falls behind the cursor.
      const lastSeq = await lastSeqOf(sdk.db, conversationId);
      return { room, messages: await botMessages(sdk.db, conversationId), lastSeq };
    },

    /**
     * Creates a Room named `name` with two or more of the user's Bots, the first the lead. Fewer
     * than two, another user's Bot, or two Bots of the same name is refused.
     */
    create: async ({ userId, ...rest }: WithUser<typeof createRoomInput>) =>
      createRoom(sdk.db, userId, parseInput(createRoomInput, rest), sdk.clock()),

    /**
     * Sends the user's Message to their Room and returns it: a Message that mentions no one wakes
     * the lead, whose Turn runs as a runner job.
     */
    send: async ({ userId, ...rest }: WithUser<typeof roomSendInput>) =>
      sendToRoom(sdk, { userId, ...parseInput(roomSendInput, rest) }),
  };
}

/** The `rooms` namespace's domain methods. */
export type RoomsApi = ReturnType<typeof roomsApi>;
