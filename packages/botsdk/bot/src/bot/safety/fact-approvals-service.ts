import { approvalExpiryMs } from "@botsdk/client/bot/review";
import { and, eq } from "drizzle-orm";

import type { BotSdkContext, Transaction } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { bot } from "../../storage";
import { appendBotMessage, controlParts } from "../conversation";
import { lockConversation, receive } from "../triggers";
import { closeLinkCard } from "./release-approvals-service";

/*
 * The `factApprovals` core service (ticket #1264, ADR 0029): how a Bot's proposed Published fact
 * reaches the owner as an Approval, the sibling of `releaseApprovals`. The card only links to the
 * feature's Facts page, the core words it and the answer, and it is the Approval's whole state: no
 * core table, and a Host without the feature carries nothing. Each method runs in the caller's
 * transaction, and the caller wakes the runner and hints the thread once it commits.
 */

/** What a feature's `needs: ["factApprovals"]` gives it. */
export type FactApprovalsService = {
  /**
   * Posts the card in the Conversation of the owner's Bot `botId`, naming the fact's key and proposed
   * value and saying `why`. It expires 7 days from now. Another user's Bot is NOT_FOUND.
   */
  post: (
    tx: Transaction,
    input: {
      userId: string;
      botId: string;
      key: string;
      value: string;
      /** The Facts page in the Host, which the Channels link to. */
      path: string;
      why: string;
      /** The Turn that asked, for the Channel it goes out on. */
      turnId: string;
      /** The tool call that asked, which a replay of it finds the card by, answered or not. */
      call?: string;
    },
  ) => Promise<{ id: string; conversationId: string; expiresAt: Date }>;
  /**
   * Closes the card with the owner's answer and wakes the Bot with it, untrusted as any Approval's
   * answer is. A card that is no longer waiting stays as it is and wakes no one: the result is null.
   */
  answer: (
    tx: Transaction,
    input: { userId: string; id: string; answer: "approved" | "declined" },
  ) => Promise<{ conversationId: string } | null>;
  /** Closes a waiting card and wakes no one. The result is as for `answer`. */
  drop: (
    tx: Transaction,
    input: { userId: string; id: string },
  ) => Promise<{ conversationId: string } | null>;
};

/** The id of a card's Trigger: one per card, so a repeat is dropped. */
export const factApprovalTriggerId = (id: string) => `fact-approval:${id}`;

/** What the Trigger wakes the Bot with. */
function answerText(key: string, answer: "approved" | "declined") {
  const proposal = `your proposal for the Published fact ${JSON.stringify(key)}`;
  return answer === "approved"
    ? `[Approval] The user approved ${proposal}. The fact is saved as you proposed it.`
    : `[Approval] The user declined ${proposal}. The fact stays as it was. Don't propose it again unless they ask.`;
}

/** The `factApprovals` service. */
export function factApprovalsService(deps: BotSdkContext): FactApprovalsService {
  return {
    post: async (tx, { userId, botId, key, value, path, why, turnId, call }) => {
      const [owner] = await tx
        .select({ botId: bot.id, conversationId: bot.conversationId })
        .from(bot)
        .where(and(eq(bot.id, botId), eq(bot.userId, userId)));
      if (!owner) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      await lockConversation(tx, owner.conversationId);
      const now = deps.clock();
      const expiresAt = new Date(now.getTime() + approvalExpiryMs);
      const id = await appendBotMessage(deps, tx, owner, {
        parts: controlParts(`I propose the Published fact "${key}" be: ${value}\n\n${why}`, {
          kind: "fact_approval",
          key,
          path,
          expiresAt: expiresAt.toISOString(),
          ...(call && { call }),
        }),
        createdAt: now,
        turnId,
      });
      return { id, conversationId: owner.conversationId, expiresAt };
    },

    answer: async (tx, { answer, ...target }) => {
      const closed = await closeLinkCard(deps, tx, target, "fact_approval", answer);
      if (!closed) return null;
      await receive(deps, tx, {
        id: factApprovalTriggerId(target.id),
        botId: closed.botId,
        conversationId: closed.conversationId,
        source: "approval",
        channel: "web",
        text: answerText(closed.card.key, answer),
        receivedAt: closed.now,
      });
      return { conversationId: closed.conversationId };
    },

    drop: async (tx, target) => {
      const closed = await closeLinkCard(deps, tx, target, "fact_approval", "dropped");
      return closed && { conversationId: closed.conversationId };
    },
  };
}
