import { toolDefinition } from "@tanstack/ai";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { appendMessage } from "../../../core/server/chat/message-tree";
import { bot, botDemonstration, botHelper, message } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { defineJob } from "../../runner/server/jobs/define";
import {
  type DemonstrationAction,
  type DemonstrationCard,
  type DemonstrationState,
  isLiveDemonstration,
  liveDemonstrationStates,
} from "../shared/demonstration";
import {
  closeScreen,
  freeScreen,
  hasLiveDemonstration,
  lockScreen,
  screensInUseError,
} from "./helper";
import type { LoopKit } from "./loop";
import { lockConversation } from "./router";
import { demonstrationCardOf, demonstrationParts } from "./store";
import { hintChanged } from "./turn";

/*
 * Demonstrations (spec #713): the user shows the Bot a task once on its Screen. `watch_user` starts
 * one in a Turn and returns at once; the user pauses, resumes, finishes or cancels it from its Show
 * me card, and a self-chaining check ends it as Done after 15 minutes of recording.
 */

/** The Bot's deferred tool that starts a Demonstration. */
export const watchUserToolName = "watch_user";

/** The most recording time a Demonstration may take; past it, it ends as Done. */
export const demonstrationTimeLimitMs = 15 * 60_000;

/** How often the time cap's check runs. */
export const demonstrationCheckMs = 60_000;

/** The runner job that checks a Demonstration's recording time. */
export const demonstrationCheckJobName = "bot.demonstration_check";

export const computerUseHelperHoldsScreenError =
  "Your Computer-use Helper is using your Screen; wait until it finishes, or stop it first.";

export const demonstrationEndedWhileOpeningError =
  "The user ended the demonstration before your Screen opened.";

export const demonstrationRunningError =
  "The user is already showing you a task; they finish it from its card first.";

const watchUserDefinition = toolDefinition({
  name: watchUserToolName,
  description:
    "Watch the user do a task once in the browser on your Screen, so you can learn it; first ask " +
    "them for the goal and what changes each time, unless they already said. It opens your Screen " +
    "for them in a Show me card in this conversation and returns at once; they pause, finish or " +
    "cancel it from the card.",
  inputSchema: z.object({
    goal: z.string().trim().min(1, "goal must not be empty").meta({
      description: "What the user will show, such as: Copy this week's payouts into the sheet.",
    }),
    inputs: z.array(z.string().trim().min(1, "an input must not be empty")).meta({
      description:
        "What changes each time the task is done, such as the date range; empty when nothing does.",
    }),
  }),
});

/** What `watch_user` needs of the Turn that calls it. */
type Watcher = { id: string; botId: string; userId: string; conversationId: string };

/**
 * The `watch_user` tool of `turn`'s loop: in one Checkpoint, a `recording` Demonstration on the
 * lowest free Screen, its Show me card, and its time cap's first check; then the Screen opened
 * afresh on the Bot's profile, in control mode for the user. It returns at once, and the
 * Demonstration outlives the Turn. Refused while the Bot's Computer-use Helper or another
 * Demonstration holds its Screen, or every Screen is held; one whose Screen won't open is cancelled,
 * and one the user ended while it opened gets its Screen closed again.
 */
export function watchUserTool(deps: BotSdkContext, turn: Watcher, kit: LoopKit) {
  return watchUserDefinition.server(async ({ goal, inputs }, context) => {
    const toolCallId = context?.toolCallId;
    const started = await kit.liveActivity(watchUserToolName, toolCallId, (tx) =>
      startDemonstration(deps, tx, turn, { goal, inputs }),
    );
    if ("error" in started) return started;
    await hintChanged(deps, turn.conversationId);
    const { demonstrationId, screen } = started;
    let opened;
    try {
      opened = await kit.computerCall(
        `${watchUserToolName}:screen`,
        toolCallId,
        async (computer) => {
          await computer.openScreen(screen, turn.botId);
          await computer.setScreenControl(screen, "control");
          return { opened: true };
        },
        false,
      );
    } catch (error) {
      // A Stop or the loop's deadline: the Demonstration never started, so it lets go of the Screen.
      await move(deps, demonstrationId, "cancel");
      throw error;
    }
    if ("error" in opened) {
      await move(deps, demonstrationId, "cancel");
      return { error: `The Screen didn't open: ${String(opened.error)}` };
    }
    // The user may have ended it from its card while the Screen opened, after its release ran.
    const [row] = await deps.db
      .select({ state: botDemonstration.state })
      .from(botDemonstration)
      .where(eq(botDemonstration.id, demonstrationId));
    if (!row || !isLiveDemonstration(row.state)) {
      await closeScreen(deps, { id: demonstrationId, userId: turn.userId, screen });
      return { error: demonstrationEndedWhileOpeningError };
    }
    return { demonstrationId, state: "recording" as const };
  });
}

/**
 * In `watch_user`'s Checkpoint: the checks, the row, its card and its first check. The user's
 * Bots are locked in id order, as `start_helper` locks them, so two can't take the last Screen.
 */
async function startDemonstration(
  deps: BotSdkContext,
  tx: Transaction,
  turn: Watcher,
  { goal, inputs }: { goal: string; inputs: string[] },
): Promise<{ demonstrationId: string; screen: number } | { error: string }> {
  await tx
    .select({ id: bot.id })
    .from(bot)
    .where(eq(bot.userId, turn.userId))
    .orderBy(asc(bot.id))
    .for("no key update");
  const [helper] = await tx
    .select({ id: botHelper.id })
    .from(botHelper)
    .where(
      and(
        eq(botHelper.botId, turn.botId),
        eq(botHelper.type, "computer_use"),
        inArray(botHelper.status, ["running", "waiting"]),
      ),
    )
    .limit(1);
  if (helper) return { error: computerUseHelperHoldsScreenError };
  if (await hasLiveDemonstration(tx, { botId: turn.botId })) {
    return { error: demonstrationRunningError };
  }
  const screen = await freeScreen(tx, turn.userId);
  if (screen === null) return { error: screensInUseError };
  await lockScreen(tx, turn.userId, screen);
  const now = deps.clock();
  const demonstrationId = uuidv7();
  await tx.insert(botDemonstration).values({
    id: demonstrationId,
    botId: turn.botId,
    userId: turn.userId,
    conversationId: turn.conversationId,
    goal,
    inputs,
    state: "recording",
    screen,
    startedAt: now,
  });
  await appendMessage(tx, turn.conversationId, {
    role: "assistant",
    parts: demonstrationParts({
      type: "demonstration",
      demonstrationId,
      goal,
      state: "recording",
      startedAt: now.toISOString(),
      endedAt: null,
      steps: 0,
    }),
    status: "complete",
    createdAt: now,
  });
  await deps
    .plugin("runner")
    .enqueueIn(
      tx,
      demonstrationCheckJobName,
      { demonstrationId, step: 1, recordedMs: 0, checkedAt: now.toISOString() },
      { idempotencyKey: checkKey(demonstrationId, 1), runAfter: after(now) },
    );
  return { demonstrationId, screen };
}

/** What the user, or a cap, does to a Demonstration. */

/**
 * The state each action moves a Demonstration to, from the states it acts in. Done goes to
 * `drafting`, which ends it; the drafting pass moves it on from there.
 */
const moves: Record<
  DemonstrationAction,
  Partial<Record<DemonstrationState, DemonstrationState>>
> = {
  pause: { recording: "paused" },
  resume: { paused: "recording" },
  done: { recording: "drafting", paused: "drafting" },
  cancel: { recording: "cancelled", paused: "cancelled" },
};

/** A Demonstration as `moveIn` read it, and the state it is in now. */
type Moved = {
  state: DemonstrationState;
  /** Whether this move ended it, so its Screen is to be released. */
  ended: boolean;
  userId: string;
  screen: number;
  conversationId: string;
};

/**
 * Applies `action` to Demonstration `demonstrationId` in `tx`, under its Conversation's row lock:
 * a state that allows it moves on, its card with it; any other stays as it is. Returns its state
 * now, or undefined when there is no such Demonstration (of `userId`, when given).
 */
async function moveIn(
  deps: BotSdkContext,
  tx: Transaction,
  demonstrationId: string,
  action: DemonstrationAction,
  userId?: string,
): Promise<Moved | undefined> {
  const [owned] = await tx
    .select({ conversationId: botDemonstration.conversationId })
    .from(botDemonstration)
    .where(
      and(
        eq(botDemonstration.id, demonstrationId),
        userId === undefined ? undefined : eq(botDemonstration.userId, userId),
      ),
    );
  if (!owned) return undefined;
  await lockConversation(tx, owned.conversationId);
  const [row] = await tx
    .select({
      state: botDemonstration.state,
      userId: botDemonstration.userId,
      screen: botDemonstration.screen,
    })
    .from(botDemonstration)
    .where(eq(botDemonstration.id, demonstrationId))
    .for("update");
  if (!row) return undefined;
  const facts = { userId: row.userId, screen: row.screen, conversationId: owned.conversationId };
  const next = moves[action][row.state];
  if (!next) return { ...facts, state: row.state, ended: false };
  const ended = !isLiveDemonstration(next);
  const now = deps.clock();
  await tx
    .update(botDemonstration)
    .set({ state: next, ...(ended && { endedAt: now }) })
    .where(eq(botDemonstration.id, demonstrationId));
  await rewriteCard(tx, owned.conversationId, demonstrationId, (card) => ({
    ...card,
    state: next,
    ...(ended && { endedAt: now.toISOString() }),
  }));
  return { ...facts, state: next, ended };
}

/** Rewrites Demonstration `demonstrationId`'s Show me card in its Conversation, in `tx`. */
async function rewriteCard(
  tx: Transaction,
  conversationId: string,
  demonstrationId: string,
  change: (card: DemonstrationCard) => DemonstrationCard,
) {
  const holding = { parts: [{ type: "demonstration", demonstrationId }] };
  const rows = await tx
    .select({ id: message.id, parts: message.parts })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.role, "assistant"),
        sql`${message.parts} @> ${JSON.stringify(holding)}::jsonb`,
      ),
    );
  for (const row of rows) {
    const card = demonstrationCardOf(row.parts);
    if (!card) continue;
    await tx
      .update(message)
      .set({ parts: demonstrationParts(change(card)) })
      .where(eq(message.id, row.id));
  }
}

/**
 * Applies `action` to a Demonstration, then, once that has committed, releases the Screen of one it
 * ended and tells the Conversation's followers. Returns its state now, or undefined when there is
 * none (of `userId`, when given).
 */
async function move(
  deps: BotSdkContext,
  demonstrationId: string,
  action: DemonstrationAction,
  userId?: string,
): Promise<DemonstrationState | undefined> {
  const moved = await deps.db.transaction((tx) =>
    moveIn(deps, tx, demonstrationId, action, userId),
  );
  if (!moved) return undefined;
  if (moved.ended) {
    await closeScreen(deps, { id: demonstrationId, userId: moved.userId, screen: moved.screen });
  }
  await hintChanged(deps, moved.conversationId);
  return moved.state;
}

/** On a Ban: cancels each of the user's live Demonstrations, which releases its Screen. */
export async function stopUserDemonstrations(deps: BotSdkContext, userId: string) {
  const live = await deps.db
    .select({ id: botDemonstration.id })
    .from(botDemonstration)
    .where(
      and(
        eq(botDemonstration.userId, userId),
        inArray(botDemonstration.state, [...liveDemonstrationStates]),
      ),
    );
  for (const { id } of live) await move(deps, id, "cancel");
}

/**
 * The user's `demonstration.pause`, `resume`, `done` or `cancel` on a Demonstration of theirs. One
 * in a state the action doesn't apply to stays as it is. Returns its state now; another user's is
 * not found.
 */
export async function actOnDemonstration(
  deps: BotSdkContext,
  userId: string,
  demonstrationId: string,
  action: DemonstrationAction,
): Promise<{ state: DemonstrationState }> {
  const state = await move(deps, demonstrationId, action, userId);
  if (!state) {
    throw rpcError("NOT_FOUND", "error.demonstrationNotFound", "Demonstration not found");
  }
  return { state };
}

/** A check's idempotency key: one per step, so a retried check queues its next one once. */
const checkKey = (demonstrationId: string, step: number) =>
  `demonstration_check:${demonstrationId}:${step}`;

const after = (time: Date) => new Date(time.getTime() + demonstrationCheckMs);

/**
 * The time cap (spec #713), a self-chaining check every `demonstrationCheckMs` while the
 * Demonstration is live, as the Computer's sleep check chains. Each adds the time since the last
 * check to `recordedMs` when it finds the Demonstration recording, so paused time doesn't count;
 * at `demonstrationTimeLimitMs` it ends the Demonstration as Done. One that has ended stops the chain.
 */
export const demonstrationCheckJob = defineJob({
  name: demonstrationCheckJobName,
  payload: z.object({
    demonstrationId: z.uuid(),
    step: z.number().int(),
    recordedMs: z.number(),
    checkedAt: z.iso.datetime(),
  }),
  run: async ({ demonstrationId, step, recordedMs, checkedAt }, { deps }) => {
    const [row] = await deps.db
      .select({ state: botDemonstration.state })
      .from(botDemonstration)
      .where(eq(botDemonstration.id, demonstrationId));
    if (!row || !isLiveDemonstration(row.state)) return;
    const now = deps.clock();
    const recorded =
      recordedMs +
      (row.state === "recording" ? Math.max(0, now.getTime() - Date.parse(checkedAt)) : 0);
    if (recorded >= demonstrationTimeLimitMs) {
      await move(deps, demonstrationId, "done");
      return;
    }
    await deps
      .plugin("runner")
      .enqueue(
        demonstrationCheckJobName,
        { demonstrationId, step: step + 1, recordedMs: recorded, checkedAt: now.toISOString() },
        { idempotencyKey: checkKey(demonstrationId, step + 1), runAfter: after(now) },
      );
  },
});
