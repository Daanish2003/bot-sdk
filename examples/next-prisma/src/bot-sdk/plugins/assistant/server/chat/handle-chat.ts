import { storedParts } from "../../shared/message-parts";
import { conversation, message } from "../../../../core/server/db/schema";
import { resumeServerSentEventsResponse } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";

import { linkAttachments, lockAttachments } from "../../../../core/server/attachments/store";
import type { ErrorParams } from "../../../../core/server/rpc-error";
import type { BotSdkContext } from "../../../../core/server/plugin";
import type { ChatUser } from "../../../../core/server/context";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { searchTextOf } from "../../shared/chat/parts";
import { chatCommandSchema } from "../../shared/chat/command";
import { runStreamDurability, START } from "../../../../core/server/chat/run-streams";
import { type PlanRefusal, planRun } from "./run-plan";
import { findConversation } from "./store";
import { attachmentKind } from "../../../../core/shared/attachments/kinds";
import { assistantState } from "../state";

/** A refusal: its HTTP status, and a body of the dictionary code and its params (spec #256). */
const refuse = (status: number, code: PlanRefusal["code"], params: ErrorParams = {}) =>
  Response.json({ code, params }, { status });

/** The error code a Message the Host's `moderate` refuses answers with (HTTP 422), #267. */
export const moderatedCode = "moderated";

/** `POST ${basePath}/run`: starts a run for the command and streams it back as server-sent events. */
export async function handleChat(
  request: Request,
  user: ChatUser,
  deps: BotSdkContext,
): Promise<Response> {
  const userId = user.id;

  const retryAfter = await deps.rateLimit("runStart", `run-start:${userId}`);
  if (retryAfter !== null) {
    return Response.json(
      { code: "error.tooManyMessages", params: {} },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const body: unknown = await request.json().catch(() => undefined);
  const parsed = chatCommandSchema.safeParse(
    body && typeof body === "object" && "forwardedProps" in body ? body.forwardedProps : undefined,
  );
  if (!parsed.success) return refuse(400, "error.invalidCommand");
  const command = parsed.data;
  const attachmentIds = [...new Set(command.attachmentIds)];
  if (command.text === undefined && attachmentIds.length > 0) {
    return refuse(400, "error.regenerateAttachments");
  }

  const owned = await findConversation(deps, userId, command.conversationId);
  if (!owned) return refuse(404, "error.conversationNotFound");

  const userMessageId = uuidv7();
  const assistantMessageId = uuidv7();
  const planned = await planRun(
    deps,
    {
      userId,
      conversation: owned,
      model: command.model,
      // The Conversation's choice, when the Model offers it: the Run sends it and the reply records it.
      reasoningEffort: owned.reasoningEffort,
      web: command.webSearch,
      replyId: assistantMessageId,
      leafId: command.parentId,
      send: { text: command.text, userMessageId, attachmentIds },
    },
    async (plan, start) => {
      const userParts = plan.added.parts;
      // The Host's input check (`moderate`, #267): after the Message is validated and before
      // anything is written. A regenerate writes no Message, so it has no input to check.
      if (command.text !== undefined) {
        const verdict = await deps.events.moderate({
          phase: "input",
          userId,
          conversationId: owned.id,
          onHostCredentials: plan.meter.onHost,
          text: command.text,
          attachments: plan.added.attachments
            .filter((file) => {
              const kind = attachmentKind(file.mediaType, file.filename);
              return kind === "image" || kind === "text";
            })
            .map((file) => ({
              name: file.filename,
              mediaType: file.mediaType,
              read: async () => file.bytes,
            })),
        });
        if (!verdict.allow) {
          return Response.json(
            {
              message: verdict.reason || "This message can't be sent",
              code: moderatedCode,
              reason: verdict.reason,
            },
            { status: 422 },
          );
        }
      }

      const now = new Date();
      const started = await deps.db.transaction(async (tx) => {
        // One run per Conversation (ADR 0002). Locking the Conversation row queues concurrent sends
        // here, so the later one sees the earlier one's streaming Message.
        await tx
          .select({ id: conversation.id })
          .from(conversation)
          .where(eq(conversation.id, owned.id))
          .for("update");
        const [running] = await tx
          .select({ id: message.id })
          .from(message)
          .where(and(eq(message.conversationId, owned.id), eq(message.status, "streaming")))
          .limit(1);
        if (running) return "streaming";
        // Holds the attachments against the orphan cleanup until they're linked.
        if (!(await lockAttachments(tx, userId, attachmentIds))) return "attachment_gone";

        await tx.insert(message).values([
          // An edit is a new user Message beside the one it replaces; a regenerate writes none.
          ...(userParts
            ? [
                {
                  id: userMessageId,
                  conversationId: owned.id,
                  parentId: command.parentId,
                  role: "user" as const,
                  parts: userParts,
                  searchText: searchTextOf(userParts),
                  status: "complete" as const,
                  createdAt: now,
                },
              ]
            : []),
          {
            id: assistantMessageId,
            conversationId: owned.id,
            parentId: userParts ? userMessageId : command.parentId,
            role: "assistant",
            parts: storedParts([]),
            model: plan.model.id,
            reasoningEffort: plan.effort ?? null,
            status: "streaming",
            createdAt: new Date(now.getTime() + 1),
            // The Run's lease starts now (ADR 0006); the Run's snapshot timer keeps it fresh.
            heartbeatAt: now,
          },
        ]);
        if (userParts) await linkAttachments(tx, userMessageId, attachmentIds);
        await tx
          .update(conversation)
          .set({
            activeLeafId: assistantMessageId,
            lastMessageAt: now,
            // Sending a Message brings an archived Conversation back to the lists.
            archivedAt: null,
            model: plan.model.id,
          })
          .where(eq(conversation.id, owned.id));
        return "started";
      });
      if (started === "streaming") return refuse(409, "error.replyStreaming");
      if (started === "attachment_gone") return refuse(404, "error.attachmentNotFound");

      await start();
      // The response reads the Run's log from the start, like any joiner (ADR 0006).
      return resumeServerSentEventsResponse({
        adapter: runStreamDurability(assistantState(deps).runStreams, assistantMessageId, START),
      });
    },
  );
  if ("refused" in planned) {
    const { status, code, params } = planned.refused;
    return refuse(status, code, params);
  }
  return planned.done;
}
