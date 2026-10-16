import { conversation, reasoningEffort } from "../db/schema";
import { z } from "zod";

import { withProjectId } from "../chat/hooks";
import { deleteAllConversations } from "../delete-user";
import { renderConversationMarkdown } from "../export-markdown";
import {
  decodeConversationCursor,
  deleteConversation,
  findConversation,
  listConversations,
  archiveAllConversations,
  archiveConversation,
  listArchivedConversations,
  listPinnedConversations,
  loadActiveBranch,
  maxPinnedConversations,
  moveConversation,
  pinConversation,
  renameConversation,
  setConversationConnections,
  setConversationModel,
  setConversationReasoningEffort,
  switchBranch,
  unarchiveConversation,
  unpinConversation,
} from "../chat/store";
import { findProject } from "../project/store";
import { protectedProcedure } from "../procedures";
import { rpcError, unusableModelError } from "../rpc-error";
import { uuidv7 } from "../lib/uuidv7";
import { assistantState } from "../../../plugins/assistant/server/state";

export const conversationRouter = {
  /** Starts an empty Conversation, with its reasoning effort if one is chosen; the first Message is sent through `/api/chat`. */
  create: protectedProcedure
    .input(
      z.object({
        model: z.string(),
        reasoningEffort: z.enum(reasoningEffort.enumValues).nullish(),
        /** The Project to create the Conversation in; it must be the caller's. */
        projectId: z.uuid().nullish(),
        /** A Temporary Conversation: kept out of the lists, search and titles. Never in a Project. */
        temporary: z.boolean().optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      if (!(await context.sdk.plugin("models").resolveModel(context.user.id, input.model))) {
        throw rpcError(
          "BAD_REQUEST",
          "error.modelNotAvailable",
          `"${input.model}" is not an available Model`,
          {
            model: input.model,
          },
        );
      }
      if (input.temporary && input.projectId) {
        throw rpcError(
          "BAD_REQUEST",
          "error.temporaryInProject",
          "A Temporary Conversation can't be in a Project",
        );
      }
      if (input.projectId && !(await findProject(context.sdk, context.user.id, input.projectId))) {
        throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
      }
      const id = uuidv7();
      await context.sdk.db.insert(conversation).values({
        id,
        userId: context.user.id,
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? null,
        projectId: input.projectId ?? null,
        temporary: input.temporary ?? false,
      });
      context.sdk.events.fire("onConversationCreated", {
        userId: context.user.id,
        conversationId: id,
        ...withProjectId(input.projectId),
        fromSharedLink: false,
      });
      return { id };
    }),

  /**
   * One page of the caller's Conversations for the Conversation panel, newest Message first, 50 at
   * a time: those outside any Project and not pinned, or those in `projectId` (the caller's own
   * Project). Pass the previous page's `nextCursor` for the next one.
   */
  list: protectedProcedure
    .input(z.object({ cursor: z.string().optional(), projectId: z.uuid().optional() }))
    .handler(async ({ context, input }) => {
      const cursor =
        input.cursor === undefined ? undefined : decodeConversationCursor(input.cursor);
      if (input.cursor !== undefined && !cursor) {
        throw rpcError("BAD_REQUEST", "error.invalidCursor", "Invalid cursor");
      }
      if (input.projectId && !(await findProject(context.sdk, context.user.id, input.projectId))) {
        throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
      }
      return listConversations(context.sdk, context.user.id, cursor, input.projectId);
    }),

  /** The Conversation with its Active Branch, oldest Message first. */
  get: protectedProcedure.input(z.object({ id: z.uuid() })).handler(async ({ context, input }) => {
    const row = await findConversation(context.sdk, context.user.id, input.id);
    if (!row) throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    const messages = await loadActiveBranch(context.sdk, row.id, row.activeLeafId);
    return {
      id: row.id,
      title: row.title,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      temporary: row.temporary,
      tools: row.toolSettings,
      archivedAt: row.archivedAt,
      messages,
    };
  }),

  /**
   * The Active Branch as a Markdown document, and the file name to download it as (ticket #252).
   * Owner only; a reply still streaming exports what is stored so far, marked as such.
   */
  exportMarkdown: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const row = await findConversation(context.sdk, context.user.id, input.id);
      if (!row) throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
      const messages = await loadActiveBranch(context.sdk, row.id, row.activeLeafId);
      return renderConversationMarkdown({ title: row.title, messages, exportedAt: new Date() });
    }),

  /**
   * Shows the Branch through `messageId`: the newest leaf under it becomes the Active Branch.
   * Doesn't bump `lastMessageAt`. CONFLICT while a reply is streaming.
   */
  switchBranch: protectedProcedure
    .input(z.object({ messageId: z.uuid() }))
    .handler(async ({ context, input }) => {
      const result = await switchBranch(context.sdk, context.user.id, input.messageId);
      if (result === "not_found")
        throw rpcError("NOT_FOUND", "error.messageNotFound", "Message not found");
      if (result === "streaming") {
        throw rpcError(
          "CONFLICT",
          "error.replyStreaming",
          "A reply is still streaming in this Conversation",
        );
      }
    }),

  /** A manual rename from the top bar. Doesn't bump `lastMessageAt`. */
  rename: protectedProcedure
    .input(z.object({ id: z.uuid(), title: z.string().trim().min(1).max(200) }))
    .handler(async ({ context, input }) => {
      const renamed = await renameConversation(context.sdk, context.user.id, input.id, input.title);
      if (!renamed)
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    }),

  /** Selects the Model the next Message and regenerate use. Doesn't bump `lastMessageAt`. */
  setModel: protectedProcedure
    .input(z.object({ id: z.uuid(), model: z.string() }))
    .handler(async ({ context, input }) => {
      const userId = context.user.id;
      if (!(await findConversation(context.sdk, userId, input.id))) {
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
      }
      const model = await context.sdk.plugin("models").resolveModel(userId, input.model);
      if (!model) {
        throw rpcError(
          "BAD_REQUEST",
          "error.modelNotAvailable",
          `"${input.model}" is not an available Model`,
          {
            model: input.model,
          },
        );
      }
      if (!(await context.sdk.plugin("models").resolveModelCall(userId, model.id))) {
        throw unusableModelError(model.provider, context.sdk.plugin("models").byok);
      }
      const updated = await setConversationModel(context.sdk, userId, input.id, model.id);
      if (!updated)
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    }),

  /** Selects the reasoning effort the next Message and regenerate use; `null` is the Model's default. */
  /**
   * Switches the MCP Connections on for the Conversation's next Message and regenerate (spec #91).
   * Each key must be an MCP server the Host lists. Doesn't bump `lastMessageAt`.
   */
  setConnections: protectedProcedure
    .input(z.object({ id: z.uuid(), connections: z.array(z.string()) }))
    .handler(async ({ context, input }) => {
      const known = new Set(assistantState(context.sdk).mcpServers.map((server) => server.key));
      if (input.connections.some((key) => !known.has(key))) {
        throw rpcError("BAD_REQUEST", "error.unknownMcpServer", "Unknown MCP server");
      }
      const updated = await setConversationConnections(context.sdk, context.user.id, input.id, [
        ...new Set(input.connections),
      ]);
      if (!updated)
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    }),

  setReasoningEffort: protectedProcedure
    .input(
      z.object({
        id: z.uuid(),
        reasoningEffort: z.enum(reasoningEffort.enumValues).nullable(),
      }),
    )
    .handler(async ({ context, input }) => {
      const updated = await setConversationReasoningEffort(
        context.sdk,
        context.user.id,
        input.id,
        input.reasoningEffort,
      );
      if (!updated)
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    }),

  /**
   * The caller's pinned Conversations, Project ones too, most recently pinned first. A pinned
   * Conversation is listed only here, not in the main list. At most `maxPinnedConversations`.
   */
  pinned: protectedProcedure.handler(({ context }) =>
    listPinnedConversations(context.sdk, context.user.id),
  ),

  /** Pins the Conversation, so it shows under Pinned. Doesn't bump `lastMessageAt`. */
  pin: protectedProcedure.input(z.object({ id: z.uuid() })).handler(async ({ context, input }) => {
    const result = await pinConversation(context.sdk, context.user.id, input.id);
    if (result === "not_found")
      throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    if (result === "temporary") {
      throw rpcError(
        "BAD_REQUEST",
        "error.temporaryPin",
        "A Temporary Conversation can't be pinned",
      );
    }
    if (result === "limit") {
      throw rpcError(
        "BAD_REQUEST",
        "error.pinLimit",
        `You can pin up to ${maxPinnedConversations} Conversations. Unpin one first.`,
        {
          max: maxPinnedConversations,
        },
      );
    }
  }),

  /** Unpins the Conversation; it returns to the main list by date. Doesn't bump `lastMessageAt`. */
  unpin: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const unpinned = await unpinConversation(context.sdk, context.user.id, input.id);
      if (!unpinned)
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    }),

  /**
   * Archives the Conversation: it leaves the main list and its Project's list, and is unpinned.
   * It is still found by search and opened by its URL. Doesn't bump `lastMessageAt`.
   */
  archive: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const archived = await archiveConversation(context.sdk, context.user.id, input.id);
      if (!archived)
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    }),

  /** Brings an archived Conversation back to the lists. Doesn't bump `lastMessageAt`. */
  unarchive: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const unarchived = await unarchiveConversation(context.sdk, context.user.id, input.id);
      if (!unarchived)
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    }),

  /**
   * One page of the caller's archived Conversations for the Archived list, Project ones too,
   * newest Message first, 50 at a time. Pass the previous page's `nextCursor` for the next one.
   */
  archived: protectedProcedure
    .input(z.object({ cursor: z.string().optional() }))
    .handler(async ({ context, input }) => {
      const cursor =
        input.cursor === undefined ? undefined : decodeConversationCursor(input.cursor);
      if (input.cursor !== undefined && !cursor) {
        throw rpcError("BAD_REQUEST", "error.invalidCursor", "Invalid cursor");
      }
      return listArchivedConversations(context.sdk, context.user.id, cursor);
    }),

  /**
   * Archives every one of the caller's Conversations that is in no Project, isn't pinned and isn't
   * archived yet. Returns how many it archived.
   */
  archiveAll: protectedProcedure.handler(async ({ context }) => ({
    count: await archiveAllConversations(context.sdk, context.user.id),
  })),

  /**
   * Moves the Conversation into one of the caller's Projects, or out of its Project when
   * `projectId` is `null`. Its Model, Messages, pin and `lastMessageAt` stay as they are.
   */
  move: protectedProcedure
    .input(z.object({ id: z.uuid(), projectId: z.uuid().nullable() }))
    .handler(async ({ context, input }) => {
      if (input.projectId && !(await findProject(context.sdk, context.user.id, input.projectId))) {
        throw rpcError("NOT_FOUND", "error.projectNotFound", "Project not found");
      }
      if (
        input.projectId &&
        (await findConversation(context.sdk, context.user.id, input.id))?.temporary
      ) {
        throw rpcError(
          "BAD_REQUEST",
          "error.temporaryMove",
          "A Temporary Conversation can't be moved into a Project",
        );
      }
      const moved = await moveConversation(context.sdk, context.user.id, input.id, input.projectId);
      if (!moved)
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    }),

  /** Deletes the Conversation for good; its Messages go with it (cascade). */
  delete: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const deleted = await deleteConversation(context.sdk, context.user.id, input.id);
      if (!deleted)
        throw rpcError("NOT_FOUND", "error.conversationNotFound", "Conversation not found");
    }),

  /**
   * Deletes every Conversation the caller owns, Project ones included, for good. Projects stay,
   * empty. Shared links go with their Conversations.
   */
  deleteAll: protectedProcedure.handler(({ context }) =>
    deleteAllConversations(context.sdk, context.user.id),
  ),
};
