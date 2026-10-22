import { type ModelMessage, toolDefinition } from "@tanstack/ai";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { appendMessage } from "../../../core/server/chat/message-tree";
import { bot, botHelper, message } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import type { MessageUsage } from "../../models/shared/usage";
import type { ComputerCard } from "../shared/helper";
import { computerOf } from "./computer-tools";
import { botHelperJobName, helperJobKey } from "./helper";
import { lockConversation } from "./router";
import { controlOf, controlParts, holdingControl } from "./store";
import { recordBotChange } from "./thread-change";
import { hintChanged } from "./turn";

/** The Computer-use Helper's tool that hands its Screen to the user (#568). */
export const askUserToolName = "ask_user";

/** What the `ask_user` call answers once the user taps Done, and the note after a rebuild. */
export const handOffAnswers = {
  done: "The user tapped Done",
  rebuilt:
    "The computer was rebuilt while you waited; the browser restarted and sign-ins were lost.",
};

/** What Done on a Helper that isn't waiting says. */
export const helperStoppedError = "This task was stopped.";

/** The `ask_user` call's result until the user taps Done, which replaces it. */
const waitingResult = { waiting: "The user has your Screen; you carry on once they tap Done." };

const askUserDefinition = toolDefinition({
  name: askUserToolName,
  description:
    "Hand your Screen to the user, at a login, verification code, captcha or payment: you stop, " +
    "and the user gets a card with a live view of your Screen, where they do that part " +
    "themselves. You carry on from here once they tap Done.",
  inputSchema: z.object({
    reason: z
      .string()
      .trim()
      .min(1, "reason must not be empty")
      .meta({
        description:
          "Where you are and what the user needs to do, such as: Sign in to Salesforce with your " +
          "password and the code from your phone.",
      }),
  }),
});

/**
 * The `ask_user` tool of a Computer-use Helper's loop. It writes nothing itself: `onAsk` gets the
 * reason, and the loop ends once the Step's calls are done, so the hand-off is written once, after
 * the transcript is complete.
 */
export function askUserTool(onAsk: (reason: string) => void) {
  return askUserDefinition.server(async ({ reason }) => {
    onAsk(reason);
    return waitingResult;
  });
}

/**
 * In the hand-off's Checkpoint transaction, under its Conversation's row lock: a `running` Helper
 * goes `waiting` with its transcript and usage saved, and `endedAt` holding when it began to wait,
 * and the Bot Message with `reason` as its text and a Computer card is written. No Trigger is sent.
 * Returns the Conversation, or `null` for a Helper that no longer runs.
 */
export async function handOff(
  deps: BotSdkContext,
  tx: Transaction,
  helper: { id: string; botId: string },
  reason: string,
  saved: { transcript: ModelMessage[]; usage: MessageUsage | null },
): Promise<{ conversationId: string } | null> {
  const [owner] = await tx
    .select({ conversationId: bot.conversationId })
    .from(bot)
    .where(eq(bot.id, helper.botId));
  if (!owner) return null;
  await lockConversation(tx, owner.conversationId);
  const now = deps.clock();
  const rows = await tx
    .update(botHelper)
    .set({ status: "waiting", ...saved, endedAt: now })
    .where(and(eq(botHelper.id, helper.id), eq(botHelper.status, "running")))
    .returning({ id: botHelper.id });
  if (rows.length === 0) return null;
  await recordBotChange(tx, owner, "helper", helper.id, now);
  await appendMessage(tx, owner.conversationId, {
    role: "assistant",
    parts: controlParts(reason, { kind: "computer", helperId: helper.id, reason, state: "open" }),
    status: "complete",
    createdAt: now,
  });
  return owner;
}

/**
 * The resumed Helper's answer to its `ask_user` call, read in its first activity: Done, and the
 * rebuild note when the Computer was rebuilt after `waitedSince`. Asking for the Screen's link wakes
 * the Computer, which tells of a rebuild; a Computer that won't wake has no note, and the first
 * Browser tool says why it can't work.
 */
export async function resumeAnswer(
  deps: BotSdkContext,
  helper: { userId: string; screen: number | null },
  waitedSince: Date,
): Promise<{ result: string; note?: string }> {
  if (helper.screen === null) return { result: handOffAnswers.done };
  const computer = computerOf(deps, helper.userId);
  await computer.screenUrls(helper.screen).catch(() => {});
  const rebuild = computer.rebuild();
  if (rebuild && rebuild.rebuiltAt > waitedSince) {
    return { result: handOffAnswers.done, note: handOffAnswers.rebuilt };
  }
  return { result: handOffAnswers.done };
}

/**
 * The saved transcript with `answer` as the result of each `ask_user` call still waiting: the last
 * Step's, which may hold more than one. Calls answered on an earlier Done keep their answer.
 */
export function answeredTranscript(transcript: readonly ModelMessage[], answer: object) {
  const asks = new Set(
    transcript
      .flatMap((entry) => entry.toolCalls ?? [])
      .filter((call) => call.function.name === askUserToolName)
      .map((call) => call.id),
  );
  const waiting = JSON.stringify(waitingResult);
  return transcript.map((entry) =>
    entry.role === "tool" && asks.has(entry.toolCallId ?? "") && entry.content === waiting
      ? { ...entry, content: JSON.stringify(answer) }
      : entry,
  );
}

/** How many Steps a saved transcript holds: one per model call. */
export const stepsIn = (transcript: readonly ModelMessage[]) =>
  transcript.filter((entry) => entry.role === "assistant").length;

/**
 * The user's Done on a waiting Helper of theirs (#568), under its Conversation's row lock: it goes
 * back to `running`, with its start moved on by the wait so its time limit counts running time
 * only, its card reads `done`, and a fresh `bot.helper` job resumes it. Its hand-off's job is
 * cancelled first in case it hasn't ended yet, since the new job takes the same key. Another user's
 * Helper is not found; one already running again (a second Done) is left as it is; any other is
 * refused: "This task was stopped." The row is read `for update`, so a stop running at the same
 * time either goes first, and Done is refused, or waits for Done and stops the resumed Helper.
 */
export async function helperDone(
  deps: BotSdkContext,
  userId: string,
  helperId: string,
): Promise<{ status: "running" }> {
  const runner = deps.plugin("runner");
  const resumed = await deps.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ conversationId: bot.conversationId })
      .from(botHelper)
      .innerJoin(bot, eq(bot.id, botHelper.botId))
      .where(and(eq(botHelper.id, helperId), eq(bot.userId, userId)));
    if (!owned) throw rpcError("NOT_FOUND", "error.helperNotFound", "Helper not found");
    await lockConversation(tx, owned.conversationId);
    const [helper] = await tx
      .select({
        status: botHelper.status,
        startedAt: botHelper.startedAt,
        endedAt: botHelper.endedAt,
        screen: botHelper.screen,
      })
      .from(botHelper)
      .where(eq(botHelper.id, helperId))
      .for("update");
    if (helper?.status === "running") return null;
    if (helper?.status !== "waiting") {
      throw rpcError("CONFLICT", "error.helperStopped", helperStoppedError);
    }
    const now = deps.clock();
    const waitedSince = helper.endedAt ?? now;
    await runner.cancelIn(tx, helperJobKey(helperId));
    const jobId = await runner.enqueueIn(
      tx,
      botHelperJobName,
      { helperId, waitedSince: waitedSince.toISOString() },
      { idempotencyKey: helperJobKey(helperId) },
    );
    await tx
      .update(botHelper)
      .set({
        status: "running",
        jobId,
        startedAt: new Date(helper.startedAt.getTime() + (now.getTime() - waitedSince.getTime())),
        endedAt: null,
      })
      .where(eq(botHelper.id, helperId));
    await recordBotChange(tx, owned, "helper", helperId, now);
    await closeComputerCard(tx, helperId, "done", now);
    return { conversationId: owned.conversationId, screen: helper.screen };
  });
  if (resumed === null) return { status: "running" };
  runner.wake();
  await hintChanged(deps, resumed.conversationId);
  // The user's control ends with the hand-off (#597), even when their client didn't give it back.
  if (resumed.screen !== null) {
    await computerOf(deps, userId)
      .setScreenControl(resumed.screen, "view")
      .catch((caught: unknown) => {
        deps.logger.error("Done couldn't give the Screen back to the Bot", caught);
      });
  }
  return { status: "running" };
}

/**
 * Flips the open Computer card of Helper `helperId` to `state` at `at`, with a `message` change, in
 * the caller's transaction, which holds the Conversation's row lock: `done`
 * on the user's Done, `cancelled` when a waiting Helper is stopped. A card already answered stays.
 * Returns whether it had an open card, which only a waiting Helper has.
 */
export async function closeComputerCard(
  tx: Transaction,
  helperId: string,
  state: Exclude<ComputerCard["state"], "open">,
  at: Date,
): Promise<boolean> {
  const rows = await openCards(tx, helperId);
  for (const row of rows) {
    const card = controlOf(row.parts, "computer")!;
    await tx
      .update(message)
      .set({ parts: controlParts(card.reason, { ...card, state }) })
      .where(eq(message.id, row.id));
    await recordBotChange(tx, row, "message", row.id, at);
  }
  return rows.length > 0;
}

/** The Messages holding Helper `helperId`'s open Computer card, in its Bot's Conversation. */
function openCards(db: Database | Transaction, helperId: string) {
  const open = holdingControl({ kind: "computer", helperId, state: "open" });
  return db
    .select({ id: message.id, parts: message.parts, conversationId: message.conversationId })
    .from(message)
    .where(
      and(
        eq(
          message.conversationId,
          sql`(select ${bot.conversationId} from ${bot} join ${botHelper} on ${botHelper.botId} = ${bot.id} where ${botHelper.id} = ${helperId})`,
        ),
        eq(message.role, "assistant"),
        sql`${message.parts} @>${JSON.stringify(open)}::jsonb`,
      ),
    );
}

/** Why waiting Helper `helperId` needs the user: its open Computer card's reason, if any. */
export async function openCardReason(
  db: Database | Transaction,
  helperId: string,
): Promise<string | undefined> {
  const [row] = await openCards(db, helperId);
  return row ? controlOf(row.parts, "computer")?.reason : undefined;
}
