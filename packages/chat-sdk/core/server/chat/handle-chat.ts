import { storedParts } from "../../shared/message-parts";
import { conversation, message } from "../db/schema/chat";
import { resumeServerSentEventsResponse } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";

import { attachmentsForSend } from "../attachments/send";
import { linkAttachments, lockAttachments } from "../attachments/store";
import { tavilyService, unusableModelMessage } from "../../shared/credentials/services";
import { resolveModelCall, resolveToolCall } from "../credentials/resolve";
import type { AppDeps } from "../deps";
import type { ChatUser } from "../context";
import { uuidv7 } from "../lib/uuidv7";
import { rateLimitedFor } from "../rate-limits";
import { resolveModel } from "./available-models";
import { parseStoredParts, searchTextOf, toModelMessages } from "../../shared/chat/parts";
import { chatCommandSchema } from "../../shared/chat/command";
import { runStreamDurability, START } from "./run-streams";
import { startRun } from "./run";
import { allowTools } from "./host-tools";
import { mcpToolsFor } from "../mcp/tools";
import { findConversation, loadPath } from "./store";
import { projectInstructionsOf } from "../project/store";
import { loadSettings } from "../settings/store";
import { systemPromptsFor } from "./system-prompts";
import { quotaExceededCode, quotaRefusal } from "./quota";
import { generationOptionsFor } from "./generation";
import { effortFor } from "../../shared/chat/models";
import { compactionFor, contextBudgetOf, estimateModelMessageTokens } from "./compaction";

const refuse = (status: number, message: string) => Response.json({ message }, { status });

/** `POST ${basePath}/run`: starts a run for the command and streams it back as server-sent events. */
export async function handleChat(
  request: Request,
  user: ChatUser,
  deps: AppDeps,
): Promise<Response> {
  const userId = user.id;

  const retryAfter = await rateLimitedFor(
    deps.counters,
    deps.rateLimits.runStart,
    `run-start:${userId}`,
  );
  if (retryAfter !== null) {
    return Response.json(
      { message: "Too many messages; try again in a moment" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const body: unknown = await request.json().catch(() => undefined);
  const parsed = chatCommandSchema.safeParse(
    body && typeof body === "object" && "forwardedProps" in body ? body.forwardedProps : undefined,
  );
  if (!parsed.success) return refuse(400, "Invalid chat command");
  const command = parsed.data;
  const attachmentIds = [...new Set(command.attachmentIds)];
  if (command.text === undefined && attachmentIds.length > 0) {
    return refuse(400, "A regenerate can't add attachments; edit the Message instead");
  }

  const owned = await findConversation(deps, userId, command.conversationId);
  if (!owned) return refuse(404, "Conversation not found");

  const model = await resolveModel(deps, userId, command.model);
  if (!model) return refuse(400, `"${command.model}" is not an available Model`);
  const call = await resolveModelCall(deps, userId, model.id);
  if (!call) return refuse(400, unusableModelMessage(model.provider, deps.byok));
  // A Run on Host credentials is refused once its Quota's window has spent the budget (ADR 0007).
  if (call.hostModel) {
    const refusal = await quotaRefusal(deps, userId);
    if (refusal) {
      return Response.json(
        {
          message: deps.byok
            ? "You've used this window's Quota; try again after it resets, or add your own key"
            : "You've used this window's Quota; try again after it resets",
          code: quotaExceededCode,
          resetsAt: refusal.resetsAt.toISOString(),
        },
        { status: 402 },
      );
    }
  }
  // The Web tools are offered only when asked for and the Model has tools. `web_search` also needs a
  // usable Tavily key: the user's own, else the Host's (ADR 0007). `fetch_url` needs none.
  const web = command.webSearch && model.tools;
  const searchCall = web ? await resolveToolCall(deps, userId, tavilyService) : null;
  // The MCP tools switched on here (spec #91). The first Message takes the composer's choice; any
  // later one reads the stored choice.
  const takesComposerTools = command.tools !== undefined && owned.activeLeafId === null;
  const toolSettings = takesComposerTools ? command.tools! : owned.toolSettings;
  // The Host's tools are offered to a Model that has tools (`createChat({ tools })`). A tool the
  // Conversation allows runs without Approval (#159).
  const hostTools = model.tools ? allowTools(deps.tools, toolSettings.allowedTools) : [];
  // Read now, so a Run keeps the Instructions it started with; a regenerate or edit reads them anew.
  const { instructions } = await loadSettings(deps, userId);
  // The Project's Instructions are read from the Conversation's Project at the same moment (spec 5).
  const systemPrompts = systemPromptsFor({
    web,
    instructions,
    projectInstructions: await projectInstructionsOf(deps, owned.projectId),
  });

  const history = await loadPath(deps, owned.id, command.parentId);
  if (command.parentId && history.length === 0) {
    return refuse(400, "The parent Message is not in this Conversation");
  }
  // A regenerate (no text) answers its parent again, so the parent must be the user's Message.
  if (command.text === undefined && history.at(-1)?.role !== "user") {
    return refuse(400, "Only a reply to your Message can be regenerated");
  }
  // A reply waiting for Approval can't be continued past its call; an edit or regenerate beside it
  // starts a new Branch and stays allowed (ADR 0008).
  if (history.at(-1)?.status === "awaiting_approval") {
    return refuse(409, "Approve or deny the tool call first");
  }
  const attachments = await attachmentsForSend(deps, {
    userId,
    model,
    attachmentIds,
    history,
  });
  if (attachments.error) return refuse(attachments.error.status, attachments.error.message);

  // The MCP tools this reply offers, opened before its history is built: a finished call of a tool
  // not offered is sent as text (spec #91). Every refusal below closes them, and so does the Run.
  const mcp = model.tools ? await mcpToolsFor(deps, userId, toolSettings) : undefined;

  // Everything that can fail runs before the Messages are written.
  const adapter = deps.adapterFor(model.id, call.credentials, {
    maxOutputTokens: call.maxOutputTokens,
  });
  const userParts =
    command.text === undefined ? undefined : storedParts([{ type: "text", text: command.text }]);
  const userMessageId = uuidv7();
  const assistantMessageId = uuidv7();
  // Each stored Message with the model messages it sends, so a cut maps back to its Message (#122).
  const sent = [
    ...history.map((row) => ({
      id: row.id,
      stored: {
        role: row.role,
        parts: parseStoredParts(row.parts),
        model: row.model,
        attachments: attachments.ofHistory(row),
      },
    })),
    ...(userParts
      ? [
          {
            id: userMessageId,
            stored: { role: "user" as const, parts: userParts, attachments: attachments.added },
          },
        ]
      : []),
  ].map(({ id, stored }) => ({
    id,
    messages: toModelMessages([stored], {
      provider: model.provider,
      webSearch: searchCall !== null,
      fetchUrl: web,
      hostTools: hostTools.length > 0,
      mcpTools: (mcp?.tools.length ?? 0) > 0,
      reads: { images: model.images, pdfs: model.pdfs },
    }),
  }));
  const messages = sent.flatMap((entry) => entry.messages);
  const owners = sent.flatMap((entry) => entry.messages.map(() => entry.id));
  // The Conversation's choice, when the Model offers it: the Run sends it and the reply records it.
  const effort = effortFor(model, owned.reasoningEffort);
  const budget = contextBudgetOf({
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
  });
  // A new Message too big for the window on its own can't be sent, so it is refused before anything is written.
  const newMessages = userParts ? (sent.at(-1)?.messages ?? []) : [];
  if (
    budget !== null &&
    newMessages.reduce((total, message) => total + estimateModelMessageTokens(message), 0) > budget
  ) {
    await mcp?.close();
    return refuse(
      400,
      "This message is too long for the Model's context window. Shorten it or remove an attachment.",
    );
  }
  const now = new Date();
  const started = await deps.db
    .transaction(async (tx) => {
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
          model: model.id,
          reasoningEffort: effort ?? null,
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
          model: model.id,
          ...(takesComposerTools && { toolSettings }),
        })
        .where(eq(conversation.id, owned.id));
      return "started";
    })
    .catch(async (caught: unknown) => {
      await mcp?.close();
      throw caught;
    });
  if (started === "streaming") {
    await mcp?.close();
    return refuse(409, "A reply is still streaming in this Conversation");
  }
  if (started === "attachment_gone") {
    await mcp?.close();
    return refuse(404, "Attachment not found");
  }

  await startRun(deps, {
    messageId: assistantMessageId,
    provider: model.provider,
    adapter,
    messages,
    webSearch: searchCall?.credentials,
    fetchUrl: web,
    hostTools,
    mcp,
    context: { userId, conversationId: owned.id },
    systemPrompts,
    modelOptions: generationOptionsFor(model.id, {
      maxOutputTokens: model.maxOutputTokens,
      effort,
    }),
    // Only a Model with a known window is compacted; the others send every Message, as before.
    compaction:
      budget === null ? undefined : compactionFor({ budget, owners, reply: assistantMessageId }),
    // A Run on Host credentials is recorded against the user's Quota (ADR 0007).
    meter: call.hostModel ? { userId, model: model.id, price: call.hostModel } : undefined,
    // Each search on the Host's Tavily key is recorded at its price (ADR 0007).
    searchMeter:
      searchCall?.pricePerSearchUsd === undefined
        ? undefined
        : { userId, pricePerSearchUsd: searchCall.pricePerSearchUsd },
  });
  // The response reads the Run's log from the start, like any joiner (ADR 0006).
  return resumeServerSentEventsResponse({
    adapter: runStreamDurability(deps.runStreams, assistantMessageId, START),
  });
}
