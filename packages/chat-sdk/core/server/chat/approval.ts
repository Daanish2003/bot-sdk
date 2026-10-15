import {
  storedParts,
  storedPartsSchema,
  type StoredPart,
  type ToolCallPart,
} from "../../shared/message-parts";
import { conversation, message } from "../db/schema/chat";
import { and, eq } from "drizzle-orm";

import type { AppDeps } from "../deps";
import { fetchUrlToolName } from "../../shared/chat/fetch-url";
import { approvalPrefix } from "./run";
import { planRun } from "./run-plan";
import { quotaExceededCode } from "./quota";
import { findConversation, findMessage } from "./store";
import type { ConversationTools } from "../../shared/chat/conversation-tools";

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
 * Whether the Run that asked offered the Web tools, for a decision that doesn't say (a Stop): a
 * send's choice isn't stored, so it is read from the reply, which holds a `web_search` or
 * `fetch_url` call when it had them.
 */
function webAsked(parts: StoredPart[]) {
  return parts.some(
    (part) =>
      part.type === "web_search" ||
      (part.type === "tool_call" && part.source === "builtin" && part.name === fetchUrlToolName),
  );
}

/**
 * Answers the call a reply is waiting on (ADR 0008): starts a new Run on the same Message. The
 * history is rebuilt from the Message tree, with the call stored without a result, so the resumed
 * Run supplies the result: the tool runs when approved, and the Model gets `declinedResult` when not.
 * The Run is the Message's next Run (`runNumber`), planned by `planRun` like a send, so it gets the
 * same Run rules as any other. With `allowForConversation` (an approval only), the call's tool is
 * also allowed for the rest of the Conversation, so its later calls run without Approval (#159).
 * `webSearch` is the user's web search choice as they decide, like a send's; without it the
 * resumed Run offers the Web tools when the reply already used them.
 */
export async function decideApproval(
  deps: AppDeps,
  userId: string,
  messageId: string,
  approved: boolean,
  allowForConversation = false,
  webSearch?: boolean,
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
  const asked = await findConversation(deps, userId, owned.conversationId);
  if (!asked) return "not_found";
  const { threadId, interruptedRunId } = owned;

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
  // The resumed Run is planned like the Run that asked, from the Conversation's stored settings, so
  // the approved call can run. Its Approval still applies to this call: the resume answers that
  // interrupt, and a call that no longer asks has none to answer. An allowance (#159) is stored
  // with the claim, for later Runs.
  const planned = await planRun(
    deps,
    {
      userId,
      conversation: asked,
      model: owned.model,
      // The effort the reply recorded when its first Run started.
      reasoningEffort: owned.reasoningEffort,
      toolSettings: asked.toolSettings,
      web: webSearch ?? webAsked(stored.data.parts),
      replyId: owned.id,
      leafId: owned.id,
    },
    async (_plan, start): Promise<DecideResult> => {
      const claimed = await deps.db.transaction(async (tx) => {
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
      });
      if (claimed !== "claimed") return claimed;

      await start({
        runNumber,
        initialParts: decided.parts,
        resume: {
          threadId,
          parentRunId: interruptedRunId,
          interruptId: `${approvalPrefix}${waiting.toolCallId}`,
          approved,
        },
      });
      return "started";
    },
  );
  if ("refused" in planned) {
    return planned.refused.code === quotaExceededCode ? "quota" : "unavailable";
  }
  return planned.done;
}
