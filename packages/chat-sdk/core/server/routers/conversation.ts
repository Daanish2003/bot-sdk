import { conversation, reasoningEffort } from "../db/schema/chat";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { resolveModel } from "../chat/available-models";
import { deleteAllConversations } from "../delete-user";
import {
  decodeConversationCursor,
  deleteConversation,
  findConversation,
  listConversations,
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
  unpinConversation,
} from "../chat/store";
import { unusableModelMessage } from "../../shared/credentials/services";
import { resolveModelCall } from "../credentials/resolve";
import { findProject } from "../project/store";
import { protectedProcedure } from "../procedures";
import { uuidv7 } from "../lib/uuidv7";

export const conversationRouter = {
  /** Starts an empty Conversation, with its reasoning effort if one is chosen; the first Message is sent through `/api/chat`. */
  create: protectedProcedure
    .input(
      z.object({
        model: z.string(),
        reasoningEffort: z.enum(reasoningEffort.enumValues).nullish(),
        /** The Project to create the Conversation in; it must be the caller's. */
        projectId: z.uuid().nullish(),
      }),
    )
    .handler(async ({ context, input }) => {
      if (!(await resolveModel(context.deps, context.user.id, input.model))) {
        throw new ORPCError("BAD_REQUEST", {
          message: `"${input.model}" is not an available Model`,
        });
      }
      if (input.projectId && !(await findProject(context.deps, context.user.id, input.projectId))) {
        throw new ORPCError("NOT_FOUND", { message: "Project not found" });
      }
      const id = uuidv7();
      await context.deps.db.insert(conversation).values({
        id,
        userId: context.user.id,
        model: input.model,
        reasoningEffort: input.reasoningEffort ?? null,
        projectId: input.projectId ?? null,
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
        throw new ORPCError("BAD_REQUEST", { message: "Invalid cursor" });
      }
      if (input.projectId && !(await findProject(context.deps, context.user.id, input.projectId))) {
        throw new ORPCError("NOT_FOUND", { message: "Project not found" });
      }
      return listConversations(context.deps, context.user.id, cursor, input.projectId);
    }),

  /** The Conversation with its Active Branch, oldest Message first. */
  get: protectedProcedure.input(z.object({ id: z.uuid() })).handler(async ({ context, input }) => {
    const row = await findConversation(context.deps, context.user.id, input.id);
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
    const messages = await loadActiveBranch(context.deps, row.id, row.activeLeafId);
    return {
      id: row.id,
      title: row.title,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      tools: row.toolSettings,
      messages,
    };
  }),

  /**
   * Shows the Branch through `messageId`: the newest leaf under it becomes the Active Branch.
   * Doesn't bump `lastMessageAt`. CONFLICT while a reply is streaming.
   */
  switchBranch: protectedProcedure
    .input(z.object({ messageId: z.uuid() }))
    .handler(async ({ context, input }) => {
      const result = await switchBranch(context.deps, context.user.id, input.messageId);
      if (result === "not_found")
        throw new ORPCError("NOT_FOUND", { message: "Message not found" });
      if (result === "streaming") {
        throw new ORPCError("CONFLICT", {
          message: "A reply is still streaming in this Conversation",
        });
      }
    }),

  /** A manual rename from the top bar. Doesn't bump `lastMessageAt`. */
  rename: protectedProcedure
    .input(z.object({ id: z.uuid(), title: z.string().trim().min(1).max(200) }))
    .handler(async ({ context, input }) => {
      const renamed = await renameConversation(
        context.deps,
        context.user.id,
        input.id,
        input.title,
      );
      if (!renamed) throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
    }),

  /** Selects the Model the next Message and regenerate use. Doesn't bump `lastMessageAt`. */
  setModel: protectedProcedure
    .input(z.object({ id: z.uuid(), model: z.string() }))
    .handler(async ({ context, input }) => {
      const userId = context.user.id;
      if (!(await findConversation(context.deps, userId, input.id))) {
        throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
      }
      const model = await resolveModel(context.deps, userId, input.model);
      if (!model) {
        throw new ORPCError("BAD_REQUEST", {
          message: `"${input.model}" is not an available Model`,
        });
      }
      if (!(await resolveModelCall(context.deps, userId, model.id))) {
        throw new ORPCError("BAD_REQUEST", {
          message: unusableModelMessage(model.provider, context.deps.byok),
        });
      }
      const updated = await setConversationModel(context.deps, userId, input.id, model.id);
      if (!updated) throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
    }),

  /** Selects the reasoning effort the next Message and regenerate use; `null` is the Model's default. */
  /**
   * Switches the MCP Connections on for the Conversation's next Message and regenerate (spec #91).
   * Each key must be an MCP server the Host lists. Doesn't bump `lastMessageAt`.
   */
  setConnections: protectedProcedure
    .input(z.object({ id: z.uuid(), connections: z.array(z.string()) }))
    .handler(async ({ context, input }) => {
      const known = new Set(context.deps.mcpServers.map((server) => server.key));
      if (input.connections.some((key) => !known.has(key))) {
        throw new ORPCError("BAD_REQUEST", { message: "Unknown MCP server" });
      }
      const updated = await setConversationConnections(context.deps, context.user.id, input.id, [
        ...new Set(input.connections),
      ]);
      if (!updated) throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
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
        context.deps,
        context.user.id,
        input.id,
        input.reasoningEffort,
      );
      if (!updated) throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
    }),

  /**
   * The caller's pinned Conversations, Project ones too, most recently pinned first. A pinned
   * Conversation is listed only here, not in the main list. At most `maxPinnedConversations`.
   */
  pinned: protectedProcedure.handler(({ context }) =>
    listPinnedConversations(context.deps, context.user.id),
  ),

  /** Pins the Conversation, so it shows under Pinned. Doesn't bump `lastMessageAt`. */
  pin: protectedProcedure.input(z.object({ id: z.uuid() })).handler(async ({ context, input }) => {
    const result = await pinConversation(context.deps, context.user.id, input.id);
    if (result === "not_found")
      throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
    if (result === "limit") {
      throw new ORPCError("BAD_REQUEST", {
        message: `You can pin up to ${maxPinnedConversations} Conversations. Unpin one first.`,
      });
    }
  }),

  /** Unpins the Conversation; it returns to the main list by date. Doesn't bump `lastMessageAt`. */
  unpin: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const unpinned = await unpinConversation(context.deps, context.user.id, input.id);
      if (!unpinned) throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
    }),

  /**
   * Moves the Conversation into one of the caller's Projects, or out of its Project when
   * `projectId` is `null`. Its Model, Messages, pin and `lastMessageAt` stay as they are.
   */
  move: protectedProcedure
    .input(z.object({ id: z.uuid(), projectId: z.uuid().nullable() }))
    .handler(async ({ context, input }) => {
      if (input.projectId && !(await findProject(context.deps, context.user.id, input.projectId))) {
        throw new ORPCError("NOT_FOUND", { message: "Project not found" });
      }
      const moved = await moveConversation(
        context.deps,
        context.user.id,
        input.id,
        input.projectId,
      );
      if (!moved) throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
    }),

  /** Deletes the Conversation for good; its Messages go with it (cascade). */
  delete: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const deleted = await deleteConversation(context.deps, context.user.id, input.id);
      if (!deleted) throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
    }),

  /**
   * Deletes every Conversation the caller owns, Project ones included, for good. Projects stay,
   * empty. Shared links go with their Conversations.
   */
  deleteAll: protectedProcedure.handler(({ context }) =>
    deleteAllConversations(context.deps, context.user.id),
  ),
};
