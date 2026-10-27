import { rpcError } from "../rpc-error";
import type { Database } from "../storage";
import { findBot } from "./conversation";

/** Throws NOT_FOUND unless `botId` is one of the user's Bots: another user's is not found. */
export async function requireOwnedBot(db: Database, userId: string, botId: string): Promise<void> {
  if (!(await findBot(db, userId, botId))) {
    throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  }
}
