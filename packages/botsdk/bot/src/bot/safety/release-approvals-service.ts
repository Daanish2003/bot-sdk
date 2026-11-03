import { approvalExpiryMs } from "@botsdk/client/bot/review";
import type { ReleaseApproval } from "@botsdk/client/bot/release-approval";
import { searchTextOf } from "@botsdk/client/message-parts";
import { and, eq, isNull, like } from "drizzle-orm";

import type { BotSdkContext, Transaction } from "../../plugin";
import { rpcError } from "../../rpc-error";
import { bot, botTrigger, message } from "../../storage";
import {
  appendBotMessage,
  controlOf,
  controlParts,
  noResetAfter,
  recordBotChange,
} from "../conversation";
import {
  type BotConversation,
  lockConversation,
  receive,
  runningTurnOf,
  startTurn,
} from "../triggers";

/*
 * The `releaseApprovals` core service (ticket #1195, ADR 0029): how a Bot's draft of a Representative
 * reaches the owner as an Approval. It posts a card that only links to the feature's page, and wakes
 * the Bot with the answer the owner gave there. The card is the Approval's whole state: it needs no
 * table, and a Host without the feature carries nothing. Each method runs in the caller's
 * transaction, so a card and an answer stand or fall with what the feature writes beside them; the
 * caller wakes the runner and hints the thread once it commits.
 */

/** What a feature's `needs: ["releaseApprovals"]` gives it. */
export type ReleaseApprovalsService = {
  /**
   * Posts the card in the Conversation of the owner's Bot `botId`, saying `why`. It expires 7 days
   * from now. Another user's Bot is NOT_FOUND.
   */
  post: (
    tx: Transaction,
    input: {
      userId: string;
      botId: string;
      representativeId: string;
      representativeName: string;
      /** The Representative's page in the Host, which the Channels link to. */
      path: string;
      why: string;
      /** The Turn that asked, for the Channel it goes out on. */
      turnId: string;
    },
  ) => Promise<{ id: string; conversationId: string; expiresAt: Date }>;
  /**
   * Closes the card with the owner's answer and wakes the Bot with it, untrusted as any Approval's
   * answer is, naming `releaseNumber` for a yes and saying so when the owner `edited` the draft first. A card that is no longer waiting (answered, dropped,
   * expired, or gone with its Bot) stays as it is and wakes no one: the result is null.
   */
  answer: (
    tx: Transaction,
    input: {
      userId: string;
      id: string;
      answer: "approved" | "declined";
      releaseNumber?: number;
      edited?: boolean;
    },
  ) => Promise<{ conversationId: string } | null>;
  /** Closes a waiting card and wakes no one. The result is as for `answer`. */
  drop: (
    tx: Transaction,
    input: { userId: string; id: string },
  ) => Promise<{ conversationId: string } | null>;
};

/** The id of a card's Trigger: one per card, so a repeat is dropped. */
export const releaseApprovalTriggerId = (id: string) => `release-approval:${id}`;

/**
 * Delivers the answers the owner gave while Bot `owner` was paused, in the transaction that resumes
 * it, which holds its Conversation's lock: the Router kept each as skipped, and its tool promised
 * the Bot it would be woken. One from before the Bot's last reset stays skipped: it has forgotten
 * the draft. Whether it started anything: if so, the caller wakes the runner once `tx` commits.
 */
export async function deliverAnswersAfterPause(
  deps: BotSdkContext,
  tx: Transaction,
  owner: BotConversation,
): Promise<boolean> {
  const delivered = await tx
    .update(botTrigger)
    .set({ skippedAt: null, skipReason: null, receivedAt: deps.clock() })
    .where(
      and(
        eq(botTrigger.botId, owner.botId),
        like(botTrigger.id, `${releaseApprovalTriggerId("")}%`),
        eq(botTrigger.skipReason, "paused"),
        isNull(botTrigger.turnId),
        noResetAfter(tx, { botId: owner.botId }, botTrigger.receivedAt),
      ),
    )
    .returning({ id: botTrigger.id });
  if (delivered.length === 0) return false;
  if (!(await runningTurnOf(tx, owner))) await startTurn(deps, tx, owner);
  return true;
}

/** What the Trigger wakes the Bot with. */
function answerText(
  card: ReleaseApproval,
  answer: "approved" | "declined",
  number?: number,
  edited?: boolean,
) {
  const draft = `your draft of the Representative ${JSON.stringify(card.representativeName)}`;
  return answer === "approved"
    ? `[Approval] The user approved ${draft}${edited ? " after changing it" : ""}. Release ${number} is live.`
    : `[Approval] The user declined ${draft}. No Release was made and the draft stays. Don't draft it again unless they ask.`;
}

/** The `releaseApprovals` service. */
export function releaseApprovalsService(deps: BotSdkContext): ReleaseApprovalsService {
  /** Closes card `id` with `answer`, under its Conversation's lock, if it still waits. */
  const close = async (
    tx: Transaction,
    { userId, id }: { userId: string; id: string },
    answer: NonNullable<ReleaseApproval["answer"]>,
  ) => {
    const [owner] = await tx
      .select({ botId: bot.id, conversationId: bot.conversationId })
      .from(message)
      .innerJoin(bot, eq(bot.conversationId, message.conversationId))
      .where(and(eq(message.id, id), eq(bot.userId, userId)));
    if (!owner) return null;
    await lockConversation(tx, owner.conversationId);
    const [row] = await tx.select({ parts: message.parts }).from(message).where(eq(message.id, id));
    const card = row && controlOf(row.parts, "release_approval");
    const now = deps.clock();
    if (!row || !card || card.answer || new Date(card.expiresAt) <= now) return null;
    await tx
      .update(message)
      .set({ parts: controlParts(searchTextOf(row.parts), { ...card, answer }, row.parts) })
      .where(eq(message.id, id));
    await recordBotChange(tx, owner, "message", id, now);
    return { ...owner, card, now };
  };

  return {
    post: async (
      tx,
      { userId, botId, representativeId, representativeName, path, why, turnId },
    ) => {
      const [owner] = await tx
        .select({ botId: bot.id, conversationId: bot.conversationId })
        .from(bot)
        .where(and(eq(bot.id, botId), eq(bot.userId, userId)));
      if (!owner) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      await lockConversation(tx, owner.conversationId);
      const now = deps.clock();
      const expiresAt = new Date(now.getTime() + approvalExpiryMs);
      const id = await appendBotMessage(deps, tx, owner, {
        parts: controlParts(`I drafted the Representative "${representativeName}".\n\n${why}`, {
          kind: "release_approval",
          representativeId,
          representativeName,
          path,
          expiresAt: expiresAt.toISOString(),
        }),
        createdAt: now,
        turnId,
      });
      return { id, conversationId: owner.conversationId, expiresAt };
    },

    answer: async (tx, { answer, releaseNumber, edited, ...target }) => {
      const closed = await close(tx, target, answer);
      if (!closed) return null;
      await receive(deps, tx, {
        id: releaseApprovalTriggerId(target.id),
        botId: closed.botId,
        conversationId: closed.conversationId,
        source: "approval",
        channel: "web",
        text: answerText(closed.card, answer, releaseNumber, edited),
        receivedAt: closed.now,
      });
      return { conversationId: closed.conversationId };
    },

    drop: async (tx, target) => {
      const closed = await close(tx, target, "dropped");
      return closed && { conversationId: closed.conversationId };
    },
  };
}
