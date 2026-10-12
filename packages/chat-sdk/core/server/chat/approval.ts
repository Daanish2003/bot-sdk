import {
  storedParts,
  storedPartsSchema,
  type StoredPart,
  type ToolCallPart,
} from "../../shared/message-parts";
import { conversation, message } from "../db/schema/chat";
import { and, eq } from "drizzle-orm";

import { attachmentsForSend } from "../attachments/send";
import { resolveModelCall } from "../credentials/resolve";
import type { AppDeps } from "../deps";
import { parseStoredParts, toModelMessages } from "../../shared/chat/parts";
import { resolveModel } from "./available-models";
import { generationOptionsFor } from "./generation";
import { quotaRefusal } from "./quota";
import { approvalPrefix, startRun } from "./run";
import { allowTools } from "./host-tools";
import { findConversation, findMessage, loadPath } from "./store";
import { mcpToolsFor } from "../mcp/tools";
import { noConversationTools, type ConversationTools } from "../../shared/chat/conversation-tools";
import { loadSettings } from "../settings/store";
import { systemPromptsFor } from "./system-prompts";
import { projectInstructionsOf } from "../project/store";

/** Why a decision didn't start a Run. `started` is the only success. */
export type DecideResult =
  | "started"
  | "not_found"
  | "not_waiting"
  | "streaming"
  | "unavailable"
  | "quota";

/** The Conversation's settings with `toolName` allowed for the rest of it (#159). */
function allowing(settings: ConversationTools, toolName: string): ConversationTools {
  return { ...settings, allowedTools: [...new Set([...settings.allowedTools, toolName])] };
}

/** What a refused call's result says to the Model and the stored part (`denied`). */
export const declinedResult = { error: "User declined tool execution" };

/**
 * Answers the call a reply is waiting on (ADR 0008): starts a new Run on the same Message. The
 * history is rebuilt from the Message tree, with the call stored without a result, so the resumed
 * Run supplies the result: the tool runs when approved, and the Model gets `declinedResult` when not.
 * The Run is the Message's next Run (`runNumber`), with the same Run rules as any other. With
 * `allowForConversation` (an approval only), the call's tool is also allowed for the rest of the
 * Conversation, so its later calls run without Approval (#159).
 */
export async function decideApproval(
  deps: AppDeps,
  userId: string,
  messageId: string,
  approved: boolean,
  allowForConversation = false,
): Promise<DecideResult> {
  const owned = await findMessage(deps, userId, messageId);
  if (!owned) return "not_found";
  if (owned.status !== "awaiting_approval") return "not_waiting";
  const stored = storedPartsSchema.safeParse(owned.parts);
  if (!stored.success) return "not_waiting";
  const waiting = stored.data.parts.find(
    (part): part is ToolCallPart => part.type === "tool_call" && part.state === "awaiting_approval",
  );
  if (!waiting || !owned.threadId || !owned.interruptedRunId) return "not_waiting";
  if (!owned.model) return "unavailable";

  const model = await resolveModel(deps, userId, owned.model);
  if (!model) return "unavailable";
  const call = await resolveModelCall(deps, userId, model.id);
  if (!call) return "unavailable";
  // A Run on Host credentials is refused once its Quota's window has spent the budget (ADR 0007).
  if (call.hostModel && (await quotaRefusal(deps, userId))) return "quota";

  const history = await loadPath(deps, owned.conversationId, owned.id);
  const attachments = await attachmentsForSend(deps, {
    userId,
    model,
    attachmentIds: [],
    history,
  });
  if (attachments.error) return "unavailable";
  // The resumed Run offers the same tools as the Run that asked, so the approved call can run. Its
  // Approval still applies to this call: the resume answers that interrupt, and a call that no
  // longer asks has none to answer. An allowance (#159) is stored with the claim, for later Runs.
  const asked = await findConversation(deps, userId, owned.conversationId);
  const askedSettings = asked?.toolSettings ?? noConversationTools;
  const hostTools = model.tools ? allowTools(deps.tools, askedSettings.allowedTools) : [];
  const mcp = model.tools && asked ? await mcpToolsFor(deps, userId, askedSettings) : undefined;
  const { instructions } = await loadSettings(deps, userId);
  const systemPrompts = systemPromptsFor({
    web: false,
    instructions,
    projectInstructions: await projectInstructionsOf(deps, asked?.projectId ?? null),
  });
  const messages = toModelMessages(
    history.map((row) => ({
      role: row.role,
      parts: parseStoredParts(row.parts),
      model: row.model,
      attachments: attachments.ofHistory(row),
    })),
    {
      provider: model.provider,
      hostTools: hostTools.length > 0,
      mcpTools: (mcp?.tools.length ?? 0) > 0,
      reads: { images: model.images, pdfs: model.pdfs },
    },
  );
  const adapter = deps.adapterFor(model.id, call.credentials, {
    maxOutputTokens: call.maxOutputTokens,
  });

  const runNumber = owned.runNumber + 1;
  const decided = storedParts(
    stored.data.parts.map((part: StoredPart) =>
      part === waiting
        ? approved
          ? { ...part, state: "running" as const }
          : { ...part, state: "denied" as const, result: declinedResult }
        : part,
    ),
  );
  const claimed = await deps.db
    .transaction(async (tx) => {
      // The same lock a send takes: one Run per Conversation (ADR 0002).
      const [locked] = await tx
        .select({ toolSettings: conversation.toolSettings })
        .from(conversation)
        .where(eq(conversation.id, owned.conversationId))
        .for("update");
      const [running] = await tx
        .select({ id: message.id })
        .from(message)
        .where(
          and(eq(message.conversationId, owned.conversationId), eq(message.status, "streaming")),
        )
        .limit(1);
      if (running) return "streaming";
      const [row] = await tx
        .update(message)
        .set({
          status: "streaming",
          parts: decided,
          runNumber,
          heartbeatAt: new Date(),
          cancelRequestedAt: null,
        })
        .where(and(eq(message.id, owned.id), eq(message.status, "awaiting_approval")))
        .returning({ id: message.id });
      if (!row) return "not_waiting";
      // The allowance is stored with the claim, on the settings read under the lock, so a refused
      // decision stores nothing and a concurrent change to the Connections is kept.
      if (allowForConversation && approved && locked) {
        await tx
          .update(conversation)
          .set({ toolSettings: allowing(locked.toolSettings, waiting.name) })
          .where(eq(conversation.id, owned.conversationId));
      }
      return "claimed";
    })
    .catch(async (caught: unknown) => {
      await mcp?.close();
      throw caught;
    });
  if (claimed !== "claimed") {
    await mcp?.close();
    return claimed;
  }

  await startRun(deps, {
    messageId: owned.id,
    runNumber,
    initialParts: decided.parts,
    resume: {
      threadId: owned.threadId,
      parentRunId: owned.interruptedRunId,
      interruptId: `${approvalPrefix}${waiting.toolCallId}`,
      approved,
    },
    provider: model.provider,
    adapter,
    messages,
    hostTools,
    mcp,
    context: { userId, conversationId: owned.conversationId },
    systemPrompts,
    modelOptions: generationOptionsFor(model.id, {
      maxOutputTokens: model.maxOutputTokens,
      effort: owned.reasoningEffort ?? undefined,
    }),
    meter: call.hostModel ? { userId, model: model.id, price: call.hostModel } : undefined,
  });
  return "started";
}
