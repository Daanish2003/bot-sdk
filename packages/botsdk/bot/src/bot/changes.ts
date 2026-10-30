import type { BotChange, BotChangeKind, BotChanges } from "@botsdk/client/bot/changes";
import { and, eq, inArray } from "drizzle-orm";

import { changesSince } from "../chat/change-log";
import { bot, botReview, botSecret, botTurn, message } from "../storage";
import type { Database } from "../storage";
import type { BotSdkContext } from "../plugin";
import { rpcError } from "../rpc-error";
import { listCheckIns, listRoutines } from "./routines";
import { listHelpers } from "./helpers";
import { listRules, reviewFields } from "./safety";
import { botSummaries } from "./context";
import { findBot, isRoomOf, toBotMessage } from "./conversation";

/** The ids of `changes` of `kind`, once each. */
const idsOf = (changes: { kind: string; refId: string }[], kind: BotChangeKind) => [
  ...new Set(changes.filter((change) => change.kind === kind).map((change) => change.refId)),
];

/**
 * The Bot that Conversation `conversationId` belongs to, when it is one of the user's Bots', or no
 * Bot when it is one of the user's Rooms (spec #1055). Another user's Conversation, or one that is
 * neither, is not found.
 */
async function botConversationOf(
  deps: BotSdkContext,
  userId: string,
  conversationId: string,
): Promise<{ botId?: string }> {
  const [found] = await deps.db
    .select({ botId: bot.id })
    .from(bot)
    .where(and(eq(bot.conversationId, conversationId), eq(bot.userId, userId)));
  if (found) return found;
  if (!(await isRoomOf(deps.db, userId, conversationId))) {
    throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
  }
  return {};
}

/**
 * The changes to the thread of the user's Bot Conversation or Room `conversationId` after seq
 * `since`, oldest first, each with what it points at as it is now; or `reload` once the log no
 * longer holds them all. Another user's Conversation, or one that is neither, is not found.
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

/** The changes to a thread after seq `since`, with their data, for its known owner. */
async function threadChanges(
  deps: BotSdkContext,
  owner: ThreadOwner,
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

/** Whose thread it is: a Bot's 1:1 Conversation, or a Room (spec #1055), which has no `botId`. */
type ThreadOwner = { userId: string; botId?: string; conversationId: string };

/**
 * What each of `changes` points at, keyed `<kind>:<refId>`, read once per kind. A Room's are its
 * Messages, its Turns and its members' Bots so far; the per-Bot kinds read nothing there yet.
 */
async function changeData(
  db: Database,
  owner: ThreadOwner,
  changes: { kind: string; refId: string }[],
): Promise<Map<string, unknown>> {
  const { botId } = owner;
  const data = new Map<string, unknown>();
  const put = (kind: BotChangeKind, rows: { id: string }[]) => {
    for (const row of rows) data.set(`${kind}:${row.id}`, row);
  };
  const messageIds = idsOf(changes, "message");
  const turnIds = idsOf(changes, "turn");
  const secretNames = idsOf(changes, "secret");
  const ruleIds = idsOf(changes, "rule");
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
          authorBotId: message.authorBotId,
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
        .where(
          and(
            botId ? eq(botTurn.botId, botId) : eq(botTurn.conversationId, owner.conversationId),
            inArray(botTurn.id, turnIds),
          ),
        )
        .then((rows) => put("turn", rows)),
    secretNames.length > 0 &&
      db
        .select({ name: botSecret.name, createdAt: botSecret.createdAt })
        .from(botSecret)
        .where(and(eq(botSecret.userId, owner.userId), inArray(botSecret.name, secretNames)))
        .then((rows) => {
          for (const row of rows) data.set(`secret:${row.name}`, row);
        }),
    ruleIds.length > 0 &&
      listRules(db, owner.userId).then((rows) =>
        put(
          "rule",
          rows.filter((row) => ruleIds.includes(row.id)),
        ),
      ),
    botId &&
      idsOf(changes, "routine").length > 0 &&
      listRoutines(db, botId).then((rows) => put("routine", rows)),
    botId &&
      reviewIds.length > 0 &&
      db
        .select(reviewFields)
        .from(botReview)
        .where(and(eq(botReview.botId, botId), inArray(botReview.id, reviewIds)))
        .then((rows) => put("review", rows)),
    botId &&
      helperIds.length > 0 &&
      listHelpers(db, botId, helperIds).then((rows) => put("helper", rows)),
    botId &&
      idsOf(changes, "check_in").length > 0 &&
      listCheckIns(db, botId).then((rows) => put("check_in", rows)),
    botId &&
      idsOf(changes, "summary").length > 0 &&
      botSummaries(db, botId, owner.conversationId).then((rows) => put("summary", rows)),
    // A 1:1 thread's Bot is its own; a Room's are its members.
    ...idsOf(changes, "bot")
      .filter((id) => !botId || id === botId)
      .map((id) =>
        findBot(db, owner.userId, id).then((found) => {
          if (!found) return;
          const { conversationId: _conversationId, ...row } = found;
          put("bot", [row]);
        }),
      ),
  ]);
  return data;
}
