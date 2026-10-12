import { randomBytes } from "node:crypto";

import { conversation, message } from "../db/schema/chat";
import { sharedLink } from "../db/schema/share";
import { and, desc, eq } from "drizzle-orm";

import { listAvailableModels, resolveModel } from "../chat/available-models";
import { loadPath } from "../chat/store";
import { attachmentsOfMessages } from "../attachments/store";
import { resolveModelCall } from "../credentials/resolve";
import type { AppDeps } from "../deps";
import { uuidv7 } from "../lib/uuidv7";
import { storedParts } from "../../shared/message-parts";
import { toSharedConversation } from "../../shared/share/conversation";

type Deps = Pick<AppDeps, "db">;
type Db = Deps["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Why a Conversation can't be shared right now, or `null` when it can. */
export type ShareBlock = "empty" | "streaming" | "error" | null;

const linkColumns = {
  token: sharedLink.token,
  title: sharedLink.title,
  updatedAt: sharedLink.updatedAt,
};

/**
 * The user's Conversation with its Active Branch's newest Message and Shared link, or
 * `undefined` when the Conversation isn't theirs.
 */
async function findShareState(db: Db | Tx, userId: string, conversationId: string) {
  const [row] = await db
    .select({
      title: conversation.title,
      activeLeafId: conversation.activeLeafId,
      leafStatus: message.status,
      link: sharedLink,
    })
    .from(conversation)
    .leftJoin(message, eq(message.id, conversation.activeLeafId))
    .leftJoin(sharedLink, eq(sharedLink.conversationId, conversation.id))
    .where(and(eq(conversation.id, conversationId), eq(conversation.userId, userId)));
  if (!row) return undefined;
  const blockedBy: ShareBlock = !row.activeLeafId
    ? "empty"
    : row.leafStatus === "streaming" || row.leafStatus === "error"
      ? row.leafStatus
      : null;
  return { ...row, blockedBy };
}

/**
 * The Conversation's Shared link (or `null`), whether the Active Branch has moved on since it was
 * taken, and why sharing is blocked. `undefined` when the Conversation isn't the user's.
 */
export async function shareStatus(deps: Deps, userId: string, conversationId: string) {
  const state = await findShareState(deps.db, userId, conversationId);
  if (!state) return undefined;
  const { link } = state;
  return {
    link: link && { token: link.token, title: link.title, updatedAt: link.updatedAt },
    movedOn: link !== null && link.leafMessageId !== state.activeLeafId,
    blockedBy: state.blockedBy,
  };
}

type UpsertResult =
  | { error: null; link: { token: string; title: string; updatedAt: Date } }
  | { error: "not_found" }
  | { error: "blocked"; blockedBy: NonNullable<ShareBlock> };

/**
 * Creates the Conversation's Shared link, or moves it to the current Active Branch under the same
 * token, freezing the title. Not while the newest Message is `streaming` or `error` (ADR 0004).
 */
export async function upsertSharedLink(
  deps: Deps,
  userId: string,
  conversationId: string,
): Promise<UpsertResult> {
  return deps.db.transaction(async (tx) => {
    // A send locks the Conversation row too, so the Active Branch can't change under us.
    await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.userId, userId)))
      .for("update");
    const state = await findShareState(tx, userId, conversationId);
    if (!state) return { error: "not_found" };
    if (state.blockedBy || !state.activeLeafId) {
      return { error: "blocked", blockedBy: state.blockedBy ?? "empty" };
    }
    const now = new Date();
    const title = state.title ?? "Untitled";
    const [link] = await tx
      .insert(sharedLink)
      .values({
        token: randomBytes(16).toString("base64url"),
        conversationId,
        leafMessageId: state.activeLeafId,
        title,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sharedLink.conversationId,
        set: { leafMessageId: state.activeLeafId, title, updatedAt: now },
      })
      .returning(linkColumns);
    if (!link) throw new Error("Saving the Shared link returned no row");
    return { error: null, link };
  });
}

/** The user's Shared links, newest share first, with each Conversation's current title. */
export async function listSharedLinks(deps: Deps, userId: string) {
  const rows = await deps.db
    .select({
      token: sharedLink.token,
      conversationId: sharedLink.conversationId,
      title: conversation.title,
      sharedAt: sharedLink.updatedAt,
    })
    .from(sharedLink)
    .innerJoin(conversation, eq(conversation.id, sharedLink.conversationId))
    .where(eq(conversation.userId, userId))
    .orderBy(desc(sharedLink.updatedAt));
  return rows.map((row) => ({ ...row, title: row.title ?? "Untitled" }));
}

/** Deletes the Conversation's Shared link, if any; `false` when the Conversation isn't theirs. */
export async function deleteSharedLink(deps: Deps, userId: string, conversationId: string) {
  const [owned] = await deps.db
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.userId, userId)));
  if (!owned) return false;
  await deps.db.delete(sharedLink).where(eq(sharedLink.conversationId, owned.id));
  return true;
}

/** What anyone with the token sees (see `toSharedConversation`). `undefined` for an unknown token. */
export async function loadSharedConversation(deps: Deps, token: string) {
  const [link] = await deps.db.select().from(sharedLink).where(eq(sharedLink.token, token));
  if (!link) return undefined;
  const path = await loadPath(deps, link.conversationId, link.leafMessageId);
  const attachments = await attachmentsOfMessages(
    deps,
    path.map((row) => row.id),
  );
  return toSharedConversation(link, path, attachments);
}

/**
 * Copies a Shared link's Branch into a new Conversation of `userId` (spec 90, ticket 144): new ids
 * with the same parent chain, thinking parts stripped, no Attachments, no Project, not pinned, and
 * the copy's title frozen from the link. Its Model is the Model of the shared Branch's last reply
 * when `userId` can still use it, else their default. `not_found` for an unknown or revoked token,
 * `no_model` when there is no Model to start on.
 */
export async function continueSharedConversation(
  deps: AppDeps,
  userId: string,
  token: string,
): Promise<{ id: string } | "not_found" | "no_model"> {
  const [link] = await deps.db.select().from(sharedLink).where(eq(sharedLink.token, token));
  if (!link) return "not_found";
  const path = await loadPath(deps, link.conversationId, link.leafMessageId);
  const lastModel = path.filter((row) => row.role === "assistant").at(-1)?.model;
  const usable = lastModel ? await resolveModel(deps, userId, lastModel) : undefined;
  const model =
    usable && (await resolveModelCall(deps, userId, usable.id))
      ? usable.id
      : (await listAvailableModels(deps, userId)).defaultModel;
  if (!model) return "no_model";

  const id = uuidv7();
  const newIds = new Map(path.map((row) => [row.id, uuidv7()]));
  await deps.db.transaction(async (tx) => {
    await tx.insert(conversation).values({ id, userId, title: link.title, model });
    // Parents come before their children in `path`, so one insert satisfies the parent foreign keys.
    await tx.insert(message).values(
      path.map((row) => ({
        id: newIds.get(row.id)!,
        conversationId: id,
        parentId: row.parentId ? newIds.get(row.parentId) : null,
        role: row.role,
        parts: storedParts(row.parts.parts.filter((part) => part.type !== "thinking")),
        model: row.model,
        status: row.status,
        searchText: row.searchText,
        createdAt: row.createdAt,
      })),
    );
    await tx
      .update(conversation)
      .set({ activeLeafId: newIds.get(path.at(-1)!.id) })
      .where(eq(conversation.id, id));
  });
  return { id };
}
