import type { BotChange, BotChangeKind, BotChanges } from "@botsdk/client/bot/changes";
import { and, eq, inArray } from "drizzle-orm";

import { changesSince } from "../../../core/server/chat/change-log";
import { bot, botReview, botSecret, botTurn, message } from "../../../core/server/storage";
import type { Database } from "../../../core/server/storage";
import type { BotSdkContext } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { listCheckIns, listRoutines } from "./routines";
import { listHelpers } from "./helpers";
import { reviewFields } from "./safety";
import { botSummaries } from "./context";
import { toBotMessage } from "./conversation";

/** The ids of `changes` of `kind`, once each. */
const idsOf = (changes: { kind: string; refId: string }[], kind: BotChangeKind) => [
  ...new Set(changes.filter((change) => change.kind === kind).map((change) => change.refId)),
];

/**
 * The Bot that Conversation `conversationId` belongs to, when it is one of the user's Bots'.
 * Another user's Conversation, or one that isn't a Bot's, is not found.
 */
async function botConversationOf(
  deps: BotSdkContext,
  userId: string,
  conversationId: string,
): Promise<{ botId: string }> {
  const [found] = await deps.db
    .select({ botId: bot.id })
    .from(bot)
    .where(and(eq(bot.conversationId, conversationId), eq(bot.userId, userId)));
  if (!found) {
    throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
  }
  return found;
}

/**
 * The changes to the thread of the user's Bot Conversation `conversationId` after seq `since`,
 * oldest first, each with what it points at as it is now; or `reload` once the log no longer holds
 * them all. Another user's Conversation, or one that isn't a Bot's, is not found.
 */
export async function conversationChanges(
  deps: BotSdkContext,
  userId: string,
  conversationId: string,
  since: number,
): Promise<BotChanges> {
  const { botId } = await botConversationOf(deps, userId, conversationId);
  return threadChanges(deps, { userId, botId, conversationId }, since);
}

/** The changes to a Bot's thread after seq `since`, with their data, for its known owner. */
async function threadChanges(
  deps: BotSdkContext,
  owner: { userId: string; botId: string; conversationId: string },
  since: number,
): Promise<BotChanges> {
  const logged = await changesSince(deps.db, owner.conversationId, since);
  if (logged.reload) return logged;
  const { changes } = logged;
  const data = await changeData(deps.db, owner, changes);
  return {
    reload: false,
    changes: changes.map(
      (change) =>
        ({ ...change, data: data.get(`${change.kind}:${change.refId}`) ?? null }) as BotChange,
    ),
  };
}

/** What each of `changes` points at, keyed `<kind>:<refId>`, read once per kind. */
async function changeData(
  db: Database,
  owner: { userId: string; botId: string; conversationId: string },
  changes: { kind: string; refId: string }[],
): Promise<Map<string, unknown>> {
  const data = new Map<string, unknown>();
  const put = (kind: BotChangeKind, rows: { id: string }[]) => {
    for (const row of rows) data.set(`${kind}:${row.id}`, row);
  };
  const messageIds = idsOf(changes, "message");
  const turnIds = idsOf(changes, "turn");
  const secretNames = idsOf(changes, "secret");
  const reviewIds = idsOf(changes, "review");
  const helperIds = idsOf(changes, "helper");
  await Promise.all([
    messageIds.length > 0 &&
      db
        .select({
          id: message.id,
          role: message.role,
          parts: message.parts,
          createdAt: message.createdAt,
        })
        .from(message)
        .where(
          and(eq(message.conversationId, owner.conversationId), inArray(message.id, messageIds)),
        )
        .then((rows) => put("message", rows.map(toBotMessage))),
    turnIds.length > 0 &&
      db
        .select({
          id: botTurn.id,
          status: botTurn.status,
          startedAt: botTurn.startedAt,
          endedAt: botTurn.endedAt,
        })
        .from(botTurn)
        .where(and(eq(botTurn.botId, owner.botId), inArray(botTurn.id, turnIds)))
        .then((rows) => put("turn", rows)),
    secretNames.length > 0 &&
      db
        .select({ name: botSecret.name, createdAt: botSecret.createdAt })
        .from(botSecret)
        .where(and(eq(botSecret.userId, owner.userId), inArray(botSecret.name, secretNames)))
        .then((rows) => {
          for (const row of rows) data.set(`secret:${row.name}`, row);
        }),
    idsOf(changes, "routine").length > 0 &&
      listRoutines(db, owner.botId).then((rows) => put("routine", rows)),
    reviewIds.length > 0 &&
      db
        .select(reviewFields)
        .from(botReview)
        .where(and(eq(botReview.botId, owner.botId), inArray(botReview.id, reviewIds)))
        .then((rows) => put("review", rows)),
    helperIds.length > 0 &&
      listHelpers(db, owner.botId, helperIds).then((rows) => put("helper", rows)),
    idsOf(changes, "check_in").length > 0 &&
      listCheckIns(db, owner.botId).then((rows) => put("check_in", rows)),
    idsOf(changes, "summary").length > 0 &&
      botSummaries(db, owner.botId, owner.conversationId).then((rows) => put("summary", rows)),
  ]);
  return data;
}
