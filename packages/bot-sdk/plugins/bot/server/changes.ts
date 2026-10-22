import { and, eq, inArray } from "drizzle-orm";

import { changesSince } from "../../../core/server/chat/change-log";
import { botReview, botSecret, botTurn, message } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { BotSdkContext } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import type { BotChange, BotChangeKind, BotChanges } from "../shared/changes";
import { listCheckIns } from "./check-in";
import { listHelpers } from "./helper-card";
import { reviewFields } from "./review";
import { listRoutines } from "./routine";
import { findBot, toBotMessage } from "./store";

/** The ids of `changes` of `kind`, once each. */
const idsOf = (changes: { kind: string; refId: string }[], kind: BotChangeKind) => [
  ...new Set(changes.filter((change) => change.kind === kind).map((change) => change.refId)),
];

/**
 * The changes to the user's Bot `botId`'s thread after seq `since`, oldest first, each with what it
 * points at as it is now; or `reload` once the log no longer holds them all. Another user's Bot is
 * not found.
 */
export async function botChanges(
  deps: BotSdkContext,
  userId: string,
  botId: string,
  since: number,
): Promise<BotChanges> {
  const found = await findBot(deps.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const logged = await changesSince(deps.db, found.conversationId, since);
  if (logged.reload) return logged;
  const { changes } = logged;
  const data = await changeData(deps.db, { userId, botId, ...found }, changes);
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
    idsOf(changes, "helper").length > 0 &&
      listHelpers(db, owner.botId).then((rows) => put("helper", rows)),
    idsOf(changes, "check_in").length > 0 &&
      listCheckIns(db, owner.botId).then((rows) => put("check_in", rows)),
  ]);
  return data;
}
