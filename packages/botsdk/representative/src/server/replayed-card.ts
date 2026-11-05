import { factApprovalSchema } from "@botsdk/client/bot/fact-approval";
import { releaseApprovalSchema } from "@botsdk/client/bot/release-approval";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import type { Transaction } from "@botsdk/bot/plugin";
import { bot, message } from "@botsdk/bot/storage";

/**
 * The card a tool call already posted, answered or not: a replay of a call whose transaction
 * committed before the Turn's Checkpoint was saved. The card's control part keeps the call, so the
 * record outlives the owner's answer. Its control, or null when the call posted none.
 */
export async function replayedCard<
  Schema extends typeof factApprovalSchema | typeof releaseApprovalSchema,
>(tx: Transaction, botId: string, schema: Schema, call: string): Promise<z.output<Schema> | null> {
  const found = { parts: [{ type: "control", control: { kind: schema.shape.kind.value, call } }] };
  const [card] = await tx
    .select({ parts: message.parts })
    .from(message)
    .innerJoin(bot, eq(bot.conversationId, message.conversationId))
    .where(and(eq(bot.id, botId), sql`${message.parts} @> ${JSON.stringify(found)}::jsonb`));
  for (const part of card?.parts.parts ?? []) {
    const control = part.type === "control" ? schema.safeParse(part.control) : null;
    if (control?.success) return control.data as z.output<Schema>;
  }
  return null;
}
