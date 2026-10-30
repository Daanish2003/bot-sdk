import type { SentFile } from "@botsdk/client/bot/files";
import { eq } from "drizzle-orm";

import { deleteBlobsBestEffort, botTrigger } from "../../storage";
import { appendMessage } from "../../chat/message-tree";

import type { BotSdkContext, Transaction } from "../../plugin";
import { sentFileBlobKey, textParts, hintChanged } from "../conversation";
import { lockConversation, pauseOf, receive } from "../triggers";

import { cancelTurn } from "./turn";

/**
 * Hands the Router a user's Message that came in on a Channel besides web (email, a messaging
 * platform) as Trigger `id`, in one transaction under the Conversation's row lock. It saves the
 * Message (`body` and the already stored `files`, recording `channel` and the email `subject`),
 * wakes the Bot like a web Message and interrupts a running Turn. A paused Bot (spec #1007) saves no
 * Message: the Trigger is kept as skipped only. Resolves with what became of it, and deletes the
 * stored files' bytes when no Message holds them.
 *
 * - `handed`: the Message and Trigger are saved;
 * - `paused`: only a skipped Trigger is;
 * - `seen`: the Trigger's id is taken already, a redelivery;
 * - `refused`: `stillValid` said no under the lock (an email address rotated meanwhile).
 */
export async function handIn(
  sdk: BotSdkContext,
  {
    conversationId,
    id,
    channel,
    body,
    subject,
    files,
    stillValid,
  }: {
    conversationId: string;
    id: string;
    channel: string;
    body: string;
    subject?: string;
    files: SentFile[];
    stillValid?: (tx: Transaction) => Promise<boolean>;
  },
): Promise<"handed" | "paused" | "seen" | "refused"> {
  const outcome = await sdk.db
    .transaction(async (tx) => {
      // The Conversation's row lock first, as in every transaction that hands the Router a Trigger.
      await lockConversation(tx, conversationId);
      if (stillValid && !(await stillValid(tx))) return "refused" as const;
      const [seen] = await tx
        .select({ id: botTrigger.id })
        .from(botTrigger)
        .where(eq(botTrigger.id, id));
      if (seen) return "seen" as const;
      const now = sdk.clock();
      // A paused Bot's message (spec #1007) saves no Message: it is kept as a skipped Trigger only.
      if ((await pauseOf(tx, conversationId))?.paused) {
        await receive(sdk, tx, {
          id,
          conversationId,
          source: "user",
          channel,
          receivedAt: now,
        });
        return "paused" as const;
      }
      const row = await appendMessage(tx, conversationId, {
        role: "user",
        parts: {
          schemaVersion: 1,
          parts: [
            ...(body ? textParts(body).parts : []),
            ...(files.length
              ? [{ type: "control" as const, control: { kind: "files" as const, files } }]
              : []),
          ],
          channel,
          ...(subject !== undefined && { subject }),
        },
        status: "complete",
        createdAt: now,
      });
      const { waitsFor } = await receive(sdk, tx, {
        id,
        conversationId,
        source: "user",
        channel,
        messageId: row.id,
        receivedAt: now,
      });
      // Like a web Message, it interrupts a running Turn, and the Turn that follows takes it.
      if (waitsFor) await cancelTurn(sdk, tx, waitsFor, "message");
      return "handed" as const;
    })
    // The same id handed in another Conversation's transaction meanwhile.
    .catch(async (error: unknown) => {
      if (isTriggerIdClash(error)) return "seen" as const;
      await deleteBlobsBestEffort(
        sdk,
        files.map((file) => sentFileBlobKey(file.id)),
      );
      throw error;
    });
  if (outcome !== "handed") {
    // No Message holds the files, so their bytes go.
    await deleteBlobsBestEffort(
      sdk,
      files.map((file) => sentFileBlobKey(file.id)),
    );
    // The Tasks view lists a paused Bot's Trigger as skipped.
    if (outcome === "paused") await hintChanged(sdk, conversationId);
    return outcome;
  }
  sdk.runner.wake();
  await hintChanged(sdk, conversationId);
  return outcome;
}

/**
 * Whether Postgres refused the Trigger because its id is taken. The query layer wraps the driver's
 * error, so this follows the `cause` chain.
 */
function isTriggerIdClash(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (code === "23505" && constraint === "bot_trigger_pkey") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
