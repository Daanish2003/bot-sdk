import { type ChoiceControl, maxChoiceOtherLength } from "@botsdk/client/bot/choice";
import type { RichControl } from "@botsdk/client/bot/rich-control";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  approveOption,
  CredentialsRejectedError,
  denyOption,
  type MessagingAccount,
  type MessagingAdapter,
  type MessagingUpdate,
  otherOption,
} from "../../channel/internal";
import type { BotSdkContext } from "../../plugin";
import { botReview, botRoutine, customRule, message } from "../../storage";
import { controlOf, noResetAfter, shownButtonsOf } from "../conversation";
import { approveRoutine, declineRoutine } from "../routines";
import { approveRule, decideReview, denyRule } from "../safety";
import { answerChoice } from "../triggers";

type Account = MessagingAccount & { platform: string };
type Owner = { userId: string; conversationId: string };

type Run = {
  sdk: BotSdkContext;
  adapter: MessagingAdapter;
  account: Account;
  owner: Owner;
  chatId: string;
  /** The Host's app URL, for links into the app; `null` when it has none. */
  appUrl: string | null;
};

type ApprovalControl = Extract<
  RichControl,
  { kind: "routine_approval" | "review_approval" | "rule_approval" }
>;

/** The note sent when the user presses Other: it is a system notice, not a Message. */
const otherNotice = "Type your answer.";

/** How many of the newest Messages with a Rich control a typed reply looks through. */
const lookback = 20;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a press of Other waits for the text of the answer. */
const otherWaitMs = 10 * 60_000;

/**
 * The chats waiting for the text of an Other answer, per SDK instance: Channel account and chat, to
 * the choice's Message and until when. Only the process that holds an account's listener sees its
 * updates (spec #1044), so this needs no shared store; after a restart the user presses Other again.
 */
const awaitingBySdk = new WeakMap<
  BotSdkContext,
  Map<string, { messageId: string; until: number }>
>();
const waitKey = (account: Account, update: MessagingUpdate) => `${account.id}:${update.chat.id}`;

/** The instance's waits for an Other answer, the expired ones gone. */
function awaitingOf(sdk: BotSdkContext) {
  let waits = awaitingBySdk.get(sdk);
  if (!waits) awaitingBySdk.set(sdk, (waits = new Map()));
  const now = sdk.clock().getTime();
  for (const [key, wait] of waits) if (wait.until <= now) waits.delete(key);
  return waits;
}

/**
 * Handles the update when it answers a Rich control of the Bot (spec #1044, #1049): a press of a
 * button, or text that answers the newest open choice (its number or exact text, or the text after
 * Other) or the newest pending Approval (`yes` or `no`). It reaches the same functions as the app's
 * `choose` and Approvals. Resolves to why it was dropped, `null` once it was handled, and
 * `undefined` when the update is not an answer and goes on as an ordinary Message. The caller has
 * checked that it comes from the Linked identity in a private chat.
 */
export async function answerFromMessaging(
  sdk: BotSdkContext,
  adapter: MessagingAdapter,
  account: Account,
  owner: Owner,
  update: MessagingUpdate,
  appUrl: string | null,
): Promise<string | null | undefined> {
  const run = { sdk, adapter, account, owner, chatId: update.chat.id, appUrl };
  try {
    if (update.press) return await pressed(run, update, update.press);
    return await typed(run, update);
  } catch (error) {
    // A refused answer (answered already, paused, no longer there) is dropped with its reason.
    if (error instanceof ORPCError) return `the answer was refused: ${error.message}`;
    throw error;
  }
}

async function pressed(
  run: Run,
  update: MessagingUpdate,
  { control: messageId, option, messageId: shownIn }: NonNullable<MessagingUpdate["press"]>,
): Promise<string | null> {
  const row = await messageOf(run, messageId);
  const control = row && controlOf(row.parts);
  if (!control) return "it presses a button of no known Message";
  if (control.kind === "choice") {
    if (!control.answer) {
      if (option === otherOption) {
        if (!control.other) return "it presses Other on a choice that has none";
        awaitingOf(run.sdk).set(waitKey(run.account, update), {
          messageId,
          until: run.sdk.clock().getTime() + otherWaitMs,
        });
        await notice(run, otherNotice);
        return null;
      }
      const text = control.options[Number(option)];
      if (text === undefined) return "it presses an option the choice does not have";
      try {
        await choose(run, messageId, { option: text });
      } catch (error) {
        // Answered meanwhile: the buttons still change to show the answer that won.
        if (!(error instanceof ORPCError)) throw error;
      }
    }
    await showAnswer(run, shownIn, messageId);
    return null;
  }
  if (!isApprovalControl(control)) return "it presses a button of a control that has none";
  if (option !== approveOption && option !== denyOption) return "it presses an unknown option";
  try {
    return await decide(run, control, option === approveOption, shownIn);
  } catch (error) {
    // Gone or paused meanwhile: the buttons stop offering it.
    if (error instanceof ORPCError) await edit(run, shownIn, "No longer open");
    throw error;
  }
}

async function typed(run: Run, update: MessagingUpdate): Promise<string | null | undefined> {
  const text = update.text.trim();
  // Text with files, or nothing, is an ordinary Message, and keeps a wait for Other.
  if (!text || update.files.length > 0) return undefined;
  try {
    return await typedAnswer(run, update, text);
  } catch (error) {
    // An answer refused because the Bot is paused or the choice was answered meanwhile goes on as
    // an ordinary Message, so a paused Bot records its skipped Trigger as for any other. Any other
    // refusal is dropped with its reason, as for a press.
    if (error instanceof ORPCError && passedOn.has(error.data?.code)) return undefined;
    throw error;
  }
}

/** The refusals of a typed answer that let its text go on as an ordinary Message. */
const passedOn = new Set<unknown>([
  "error.botPaused",
  "error.botPausedApproval",
  "error.choiceAnswered",
]);

async function typedAnswer(
  run: Run,
  update: MessagingUpdate,
  text: string,
): Promise<null | undefined> {
  const waits = awaitingOf(run.sdk);
  const key = waitKey(run.account, update);
  const waiting = waits.get(key);
  if (waiting) {
    waits.delete(key);
    const row = await messageOf(run, waiting.messageId);
    const choice = row && controlOf(row.parts, "choice");
    if (row && choice && !choice.answer) {
      await choose(run, row.id, { other: text.slice(0, maxChoiceOtherLength) });
      await showAnswer(run, shownIn(run, row.parts), row.id);
      return null;
    }
  }
  const open = await openControls(run);
  if (open.choice) {
    const picked = pick(open.choice.control, text);
    if (picked !== undefined) {
      await choose(run, open.choice.id, { option: picked });
      await showAnswer(run, shownIn(run, open.choice.parts), open.choice.id);
      return null;
    }
  }
  if (open.approval && /^(yes|no)$/i.test(text)) {
    const { control, parts } = open.approval;
    return decide(run, control, text.toLowerCase() === "yes", shownIn(run, parts));
  }
  return undefined;
}

/**
 * The platform message that shows a Message's buttons in this chat, as its delivery kept it, so a
 * typed answer closes them as a press does; `null` when they were shown elsewhere or not kept.
 */
function shownIn(run: Run, parts: { [key: string]: unknown }): string | null {
  const shown = shownButtonsOf(parts);
  return shown?.platform === run.account.platform && shown.chatId === run.chatId
    ? shown.messageId
    : null;
}

/** The option of `choice` that `text` names: its number, or its exact text. */
function pick(choice: ChoiceControl, text: string): string | undefined {
  if (/^\d+$/.test(text)) return choice.options[Number(text) - 1];
  return choice.options.find((option) => option === text);
}

const choose = (run: Run, messageId: string, answer: { option: string } | { other: string }) =>
  answerChoice(run.sdk, run.owner.userId, {
    botId: run.account.botId,
    messageId,
    answer,
    channel: run.account.platform,
  });

async function messageOf({ sdk, owner }: Run, id: string) {
  // A malformed reference is no Message.
  if (!uuidPattern.test(id)) return undefined;
  const [row] = await sdk.db
    .select({ id: message.id, parts: message.parts })
    .from(message)
    .where(
      and(
        eq(message.id, id),
        eq(message.conversationId, owner.conversationId),
        eq(message.role, "assistant"),
      ),
    );
  return row;
}

/**
 * The newest open choice and the newest pending Approval among the Bot's newest Messages that hold
 * a Rich control, from after its reset mark.
 */
async function openControls({ sdk, owner }: Run) {
  const rows = await sdk.db
    .select({ id: message.id, parts: message.parts })
    .from(message)
    .where(
      and(
        eq(message.conversationId, owner.conversationId),
        eq(message.role, "assistant"),
        sql`${message.parts} -> 'parts' @> '[{"type": "control"}]'::jsonb`,
        noResetAfter(sdk.db, { conversationId: owner.conversationId }, message.createdAt),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(lookback);
  type Open<Control> = { id: string; control: Control; parts: (typeof rows)[number]["parts"] };
  let choice: Open<ChoiceControl> | undefined;
  let approval: Open<ApprovalControl> | undefined;
  for (const row of rows) {
    const control = controlOf(row.parts);
    if (!control) continue;
    if (control.kind === "choice") {
      if (!choice && !control.answer) choice = { id: row.id, control, parts: row.parts };
    } else if (!approval && isApprovalControl(control) && (await pending(sdk, control))) {
      approval = { id: row.id, control, parts: row.parts };
    }
  }
  return { choice, approval };
}

const isApprovalControl = (control: RichControl): control is ApprovalControl =>
  control.kind === "routine_approval" ||
  control.kind === "review_approval" ||
  control.kind === "rule_approval";

/** Whether the Approval still waits for the user. */
async function pending(sdk: BotSdkContext, control: ApprovalControl): Promise<boolean> {
  const rows =
    control.kind === "routine_approval"
      ? await sdk.db
          .select({ id: botRoutine.id })
          .from(botRoutine)
          .where(and(eq(botRoutine.id, control.routineId), eq(botRoutine.state, "pending")))
      : control.kind === "rule_approval"
        ? await sdk.db
            .select({ id: customRule.id })
            .from(customRule)
            .where(and(eq(customRule.id, control.ruleId), eq(customRule.state, "proposed")))
        : await sdk.db
            .select({ id: botReview.id })
            .from(botReview)
            .where(
              and(
                eq(botReview.id, control.reviewId),
                inArray(botReview.state, ["waiting", "pending"]),
              ),
            );
  return rows.length > 0;
}

/**
 * The user's yes or no to an Approval, through the app's own functions. When it came from a button
 * (`shownIn`), that message's buttons change to say what was decided.
 */
async function decide(
  run: Run,
  control: ApprovalControl,
  yes: boolean,
  shownIn: string | null,
): Promise<null> {
  const { sdk, owner } = run;
  let outcome = yes ? "Approved" : "Denied";
  let webhook = false;
  if (!(await pending(sdk, control))) outcome = "Already answered";
  else if (control.kind === "routine_approval") {
    if (yes) {
      // A webhook URL's token is shown once, and never on a Channel: the app issues a new one.
      webhook = !!(await approveRoutine(sdk, owner.userId, control.routineId)).webhookToken;
    } else await declineRoutine(sdk, owner.userId, control.routineId);
  } else if (control.kind === "rule_approval") {
    await (yes ? approveRule : denyRule)(sdk, owner.userId, control.ruleId);
  } else {
    const result = await decideReview(
      sdk,
      owner.userId,
      control.reviewId,
      yes ? "allowed" : "denied",
    );
    if (!result.decided) outcome = result.state === "expired" ? "Expired" : "Already answered";
  }
  if (shownIn) await edit(run, shownIn, outcome);
  if (webhook) {
    const lead = "Get its webhook URL in the app";
    const page = run.appUrl && `${run.appUrl}/bots/${run.account.botId}`;
    try {
      await notice(run, `Approved. ${page ? `[${lead}](${page})` : `${lead}.`}`);
    } catch (error) {
      // The approval is kept: a resent update would only find it answered, so it isn't thrown.
      sdk.logger.error(
        `The webhook Routine's approval notice was not sent on ${run.account.platform}: ${String(error)}`,
      );
    }
  }
  return null;
}

/** Changes the buttons of the choice's message, when known, to show the answer it holds. */
async function showAnswer(run: Run, shownIn: string | null, messageId: string): Promise<void> {
  if (!shownIn) return;
  const row = await messageOf(run, messageId);
  const answer = row && controlOf(row.parts, "choice")?.answer;
  if (answer) await edit(run, shownIn, answer.text);
}

async function edit(run: Run, messageId: string, chosen: string): Promise<void> {
  try {
    await run.adapter.editButtons(
      run.account,
      { chatId: run.chatId, messageId, chosen },
      { fetch: run.sdk.fetch },
    );
  } catch (error) {
    if (error instanceof CredentialsRejectedError) throw error;
    // The answer is stored; only the buttons stay as they were.
    run.sdk.logger.error("Editing the buttons of a Channel message failed", error);
  }
}

/** Sends a system notice in the chat: it is not a Message of the Conversation. */
async function notice(run: Run, text: string): Promise<void> {
  await run.adapter.send(run.account, { chatId: run.chatId, text }, { fetch: run.sdk.fetch });
}
