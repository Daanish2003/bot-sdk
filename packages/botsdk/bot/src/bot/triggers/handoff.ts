import { type Handoff, hopLimit, mentionedMembers } from "@botsdk/client/bot/mentions";
import { eq, max } from "drizzle-orm";

import { bot, botTrigger } from "../../storage";
import type { BotSdkContext, Transaction } from "../../plugin";
import { roomOf } from "../conversation";
import { receive, recordSkipChange } from "./router";

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
  const to = mentionedMembers(text, room.members).filter((botId) => botId !== turn.botId);
  if (to.length === 0) return undefined;
  const [taken] = await tx
    .select({ hops: max(botTrigger.hops) })
    .from(botTrigger)
    .where(eq(botTrigger.turnId, turn.id));
  return { to, hops: (taken?.hops ?? 0) + 1 };
}

/**
 * Hands Message `messageId` on to each Bot its `handoff` names, in `tx`, as an `agent` Trigger
 * carrying the Message. It never interrupts: a Bot running a Turn in the Room takes it in its next
 * one. A hop past `hopLimit` is kept as skipped `hop_limit` and never runs. As a Check-in's fire
 * does, it wakes no Bot whose Model the user can't use, or once their Quota is spent. Call the
 * runner's `wake()` once `tx` has committed.
 */
export async function handOff(
  deps: BotSdkContext,
  tx: Transaction,
  turn: SendingTurn,
  messageId: string,
  handoff: Handoff,
): Promise<void> {
  const now = deps.clock();
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
    };
    if (handoff.hops > hopLimit) {
      await tx.insert(botTrigger).values({ ...trigger, skippedAt: now, skipReason: "hop_limit" });
      await recordSkipChange(tx, { botId, conversationId: turn.conversationId }, trigger, now);
      continue;
    }
    const [target] = await tx.select({ model: bot.model }).from(bot).where(eq(bot.id, botId));
    const call = target && (await deps.models.resolveModelCall(turn.userId, target.model));
    if (!call || !(await call.meter.mayRun()).ok) continue;
    await receive(deps, tx, trigger);
  }
}
