import { type Handoff, hopLimit } from "@botsdk/client/bot/mentions";
import { mentionedInMessage } from "@botsdk/client/message-format";
import { and, eq, gte, isNull, max, or } from "drizzle-orm";

import { bot, botAssignment, botTrigger, botTurn } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import { roomOf } from "../conversation";
import {
  type BotConversation,
  lockConversationsInOrder,
  oneToOnesOf,
  receive,
  recordSkipChange,
} from "./router";
import { untrustedAssignmentChannel } from "./trigger-ids";

/** The Turn a Bot's Room Message comes from. */
type SendingTurn = { id: string; botId: string; userId: string; conversationId: string };

/**
 * The handoff a Message the Bot sends in Turn `turn` makes (spec #1055): the other members of the
 * Room it @mentions, never the Bot itself, one hop further than the highest of the Triggers the Turn
 * took. A Message outside a Room, or one that mentions no other member, makes none. Read it before
 * the Message is saved, so the Message carries it.
 */
export async function handoffOf(
  tx: Transaction,
  turn: SendingTurn,
  text: string,
): Promise<Handoff | undefined> {
  // A Message with no @ mentions no one, so it skips the Room's read.
  if (!text.includes("@")) return undefined;
  const room = await roomOf(tx, turn.conversationId);
  if (!room) return undefined;
  const to = mentionedInMessage(text, room.members).filter((botId) => botId !== turn.botId);
  if (to.length === 0) return undefined;
  const [taken] = await tx
    .select({ hops: max(botTrigger.hops) })
    .from(botTrigger)
    .where(eq(botTrigger.turnId, turn.id));
  return { to, hops: (taken?.hops ?? 0) + 1 };
}

/**
 * Whether Turn `turn` has touched untrusted work (#1327): it took an untrusted Assignment's Trigger
 * or a hand-off itself from untrusted work, or its Bot held an untrusted Assignment at any point
 * since the Turn started, one that ended before now included.
 */
async function touchedUntrustedWork(tx: Transaction, turn: SendingTurn): Promise<boolean> {
  const [taken] = await tx
    .select({ id: botTrigger.id })
    .from(botTrigger)
    .where(
      and(
        eq(botTrigger.turnId, turn.id),
        or(eq(botTrigger.channel, untrustedAssignmentChannel), eq(botTrigger.fromUntrusted, true)),
      ),
    )
    .limit(1);
  if (taken) return true;
  const [held] = await tx
    .select({ id: botAssignment.id })
    .from(botAssignment)
    .innerJoin(botTurn, eq(botTurn.id, turn.id))
    .where(
      and(
        eq(botAssignment.assignedBotId, turn.botId),
        eq(botAssignment.assignerTrusted, false),
        or(isNull(botAssignment.endedAt), gte(botAssignment.endedAt, botTurn.startedAt)),
      ),
    )
    .limit(1);
  return held !== undefined;
}

/**
 * Hands Message `messageId` on to each Bot its `handoff` names, in `tx`, as an `agent` Trigger
 * carrying the Message, stamped with whether its Turn touched untrusted work. It never interrupts: a Bot running a Turn in the Room takes it in its next
 * one. A hop past `hopLimit` is kept as skipped `hop_limit` and never runs. As a Check-in's fire
 * does, it wakes no Bot whose Model the user can't use, or once their Quota is spent. `tx` holds
 * the locks `lockHandoff` takes. Returns the Bots whose Room Turn it started, whose 1:1 threads the
 * caller hints (`hintBotThread`) as it calls the runner's `wake()`, once `tx` has committed.
 */
export async function handOff(
  deps: BotSdkContext,
  tx: Transaction,
  turn: SendingTurn,
  messageId: string,
  handoff: Handoff,
): Promise<BotConversation[]> {
  const started: BotConversation[] = [];
  const now = deps.clock();
  const fromUntrusted = await touchedUntrustedWork(tx, turn);
  for (const botId of handoff.to) {
    const trigger = {
      id: messageId,
      botId,
      conversationId: turn.conversationId,
      source: "agent" as const,
      channel: "room",
      messageId,
      receivedAt: now,
      hops: handoff.hops,
      fromUntrusted,
    };
    if (handoff.hops > hopLimit) {
      await tx.insert(botTrigger).values({ ...trigger, skippedAt: now, skipReason: "hop_limit" });
      await recordSkipChange(tx, { botId, conversationId: turn.conversationId }, trigger, now);
      continue;
    }
    const [target] = await tx.select({ model: bot.model }).from(bot).where(eq(bot.id, botId));
    const call = target && (await deps.models.resolveModelCall(turn.userId, target.model));
    if (!call || !(await call.meter.mayRun()).ok) continue;
    const received = await receive(deps, tx, trigger);
    if (received.started) started.push({ botId, conversationId: turn.conversationId });
  }
  return started;
}

/**
 * Takes the Room's row lock with those of the 1:1 Conversations of the Bots `handoff` names, in id
 * order, before the Message is saved: a Room Turn it starts writes its Bot's 1:1 too (`startTurn`).
 */
export async function lockHandoff(
  tx: Transaction,
  turn: SendingTurn,
  handoff: Handoff,
): Promise<void> {
  await lockConversationsInOrder(tx, [turn.conversationId, ...(await oneToOnesOf(tx, handoff.to))]);
}
