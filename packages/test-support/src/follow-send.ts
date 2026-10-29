import type { BotMessage, TurnStatus } from "@botsdk/client/bot/turn";
import { setTimeout as sleep } from "node:timers/promises";

import { eq } from "drizzle-orm";

import type { Database } from "@botsdk/bot/storage";
import { botTrigger, botTurn, message } from "@botsdk/bot/storage";
import type { BotSdkContext } from "@botsdk/bot/plugin";
import { botMessages } from "@botsdk/bot/bot/conversation";
import { sendToBot } from "@botsdk/bot/bot/turn";
import { getTestDb } from "./test-database";

/** What a followed send yields: each Message as it is saved, then how the Turn ended. */
export type BotSendEvent =
  | { type: "message"; message: BotMessage }
  | { type: "turnEnded"; status: TurnStatus };

/** How often a followed send re-reads its Turn. */
const pollMs = 20;

/**
 * Follows the Turn that takes the saved user Message `saved`, from Postgres: yields the Message,
 * then each Message sent after it, then `turnEnded` once a Turn has taken it and ended. `bots.send`
 * returns only the saved Message (ADR 0026), so tests and evals that wait for a Turn use this.
 */
export async function* followSaved(
  db: Database,
  saved: BotMessage,
  signal?: AbortSignal,
): AsyncGenerator<BotSendEvent> {
  yield { type: "message", message: saved };
  const [row] = await db
    .select({ conversationId: message.conversationId })
    .from(message)
    .where(eq(message.id, saved.id));
  if (!row) return;
  const shown = new Set([saved.id]);
  while (!signal?.aborted) {
    // The status first: the Messages read after it hold every one sent before the Turn ended.
    // A Trigger no Turn has taken yet has no status: it waits in the Conversation queue.
    const [taken] = await db
      .select({ status: botTurn.status, skippedAt: botTrigger.skippedAt })
      .from(botTrigger)
      .leftJoin(botTurn, eq(botTurn.id, botTrigger.turnId))
      .where(eq(botTrigger.id, saved.id));
    for (const sent of await botMessages(db, row.conversationId, saved.createdAt)) {
      if (shown.has(sent.id)) continue;
      shown.add(sent.id);
      yield { type: "message", message: sent };
    }
    if (!taken) {
      yield { type: "turnEnded", status: "error" };
      return;
    }
    // A Trigger skipped while it waited (a Bot pause, spec #1007): no Turn will take it.
    if (taken.skippedAt) {
      yield { type: "turnEnded", status: "stopped" };
      return;
    }
    if (taken.status !== null && taken.status !== "running") {
      yield { type: "turnEnded", status: taken.status };
      return;
    }
    // Not the global timer: a test may fake it.
    await sleep(pollMs);
  }
}

/**
 * Calls `bots.send` on `client` and follows its Turn. `options.signal` goes to the call and ends the
 * follow.
 */
export async function followSend(
  client: {
    bots: {
      send: (
        input: { botId: string; id: string; text: string; files?: string[]; timeZone?: string },
        options?: { signal?: AbortSignal },
      ) => Promise<BotMessage>;
    };
  },
  input: { botId: string; id: string; text: string; files?: string[]; timeZone?: string },
  options?: { signal?: AbortSignal },
): Promise<AsyncGenerator<BotSendEvent>> {
  return followSaved(getTestDb(), await client.bots.send(input, options), options?.signal);
}

/** `sendToBot`, then follows its Turn. */
export async function sendAndFollow(
  deps: BotSdkContext,
  input: Parameters<typeof sendToBot>[1] & { signal?: AbortSignal },
): Promise<AsyncGenerator<BotSendEvent>> {
  const { signal, ...send } = input;
  return followSaved(deps.db, await sendToBot(deps, send), signal);
}
