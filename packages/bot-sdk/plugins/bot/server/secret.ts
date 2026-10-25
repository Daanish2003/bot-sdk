import { and, asc, eq, gt, or } from "drizzle-orm";

import {
  decryptCredentials,
  encryptCredentials,
  encryptionKid,
  kidOf,
} from "../../../core/server/credentials/encryption";
import { rotateInPasses } from "../../../core/server/credentials/rotation";
import { bot, botSecret } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import { rpcError } from "../../../core/server/rpc-error";
import type { BotSdkContext } from "../../../core/server/plugin";
import type { BotSecret } from "../shared/secret";
import {
  minSecretLength,
  savedSecretText,
  secretEncryption,
  usableSecretValue,
} from "./secret-values";
import { hintChanged } from "./turn";
import { recordBotChange } from "./thread-change";
import { lockConversation, receive } from "./router";
import { findBot } from "./store";

export { savedSecretText } from "./secret-values";

/** The Trigger id of a save of Secret `name` at `at`, unique per save. */
const savedTriggerId = (userId: string, name: string, at: Date) =>
  `secret:${userId}:${name}:${at.getTime()}`;

/**
 * Saves Secret `name` for the user, replacing an earlier one, and wakes their Bot `botId` with the
 * Trigger "Saved secret NAME". The Turn the Bot is in doesn't wait for it. The value goes into the
 * encrypted row and nowhere else: not the Trigger, a Message or a log.
 */
export async function saveSecret(
  sdk: BotSdkContext,
  userId: string,
  { botId, name, value: given }: { botId: string; name: string; value: string },
): Promise<void> {
  const found = await findBot(sdk.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  const value = usableSecretValue(given);
  if (!value) {
    throw rpcError("BAD_REQUEST", "error.secretTooShort", "Secret value is too short", {
      min: minSecretLength,
    });
  }
  // The save always stores the Secret. It wakes the Bot only while the Bot can run, as a Check-in
  // fire does: no Turn starts on a Model the user can't use or once their Quota is spent.
  const call = await sdk.models.resolveModelCall(userId, found.model);
  const mayWake = call ? (await call.meter.mayRun()).ok : false;
  const encrypted = encryptCredentials({ value }, secretEncryption(sdk, userId, name));
  const now = sdk.clock();
  await sdk.db.transaction(async (tx) => {
    // The Conversation's row lock first, as in every write that changes the Bot thread.
    await lockConversation(tx, found.conversationId);
    await tx
      .insert(botSecret)
      .values({ userId, name, encrypted, createdAt: now })
      .onConflictDoUpdate({
        target: [botSecret.userId, botSecret.name],
        set: { encrypted, createdAt: now },
      });
    await recordBotChange(tx, found, "secret", name, now);
    if (!mayWake) return;
    await receive(sdk, tx, {
      id: savedTriggerId(userId, name, now),
      conversationId: found.conversationId,
      source: "user",
      channel: "web",
      text: savedSecretText(name),
      receivedAt: now,
    });
  });
  if (mayWake) sdk.plugin("runner").wake();
  await hintChanged(sdk, found.conversationId);
}

/** The user's Secrets by name, with when each was saved: never a value. */
export async function listSecrets(db: Database, userId: string): Promise<BotSecret[]> {
  return db
    .select({ name: botSecret.name, createdAt: botSecret.createdAt })
    .from(botSecret)
    .where(eq(botSecret.userId, userId))
    .orderBy(asc(botSecret.name));
}

/**
 * Deletes the user's Secret `name`, a `secret` change in each of their Bots' threads, since a Secret
 * is the user's, not one Bot's. Deleting one that isn't there does nothing.
 */
export async function deleteSecret(
  sdk: BotSdkContext,
  userId: string,
  name: string,
): Promise<void> {
  const now = sdk.clock();
  const changed = await sdk.db.transaction(async (tx) => {
    const owned = await tx
      .select({ conversationId: bot.conversationId })
      .from(bot)
      .where(eq(bot.userId, userId))
      .orderBy(asc(bot.conversationId));
    // The Conversations' row locks first, in one order, as in every write that changes a thread.
    for (const { conversationId } of owned) await lockConversation(tx, conversationId);
    const deleted = await tx
      .delete(botSecret)
      .where(and(eq(botSecret.userId, userId), eq(botSecret.name, name)))
      .returning({ name: botSecret.name });
    if (deleted.length === 0) return [];
    for (const owner of owned) await recordBotChange(tx, owner, "secret", name, now);
    return owned;
  });
  for (const { conversationId } of changed) await hintChanged(sdk, conversationId);
}

/** One scan over every Secret; `raced` counts updates that found the row already changed. */
async function rotateOnce(sdk: BotSdkContext, batchSize: number) {
  const result = { reencrypted: 0, raced: 0, unreadable: 0 };
  let after: { userId: string; name: string } | undefined;
  for (;;) {
    const rows = await sdk.db
      .select()
      .from(botSecret)
      .where(
        after &&
          or(
            gt(botSecret.userId, after.userId),
            and(eq(botSecret.userId, after.userId), gt(botSecret.name, after.name)),
          ),
      )
      .orderBy(asc(botSecret.userId), asc(botSecret.name))
      .limit(batchSize);
    for (const row of rows) {
      const options = secretEncryption(sdk, row.userId, row.name);
      const decrypted = decryptCredentials(row.encrypted, options);
      if (!decrypted.ok) {
        result.unreadable += 1;
        continue;
      }
      if (kidOf(row.encrypted) === encryptionKid(options.secrets, options.kind)) continue;
      const updated = await sdk.db
        .update(botSecret)
        .set({ encrypted: encryptCredentials(decrypted.credentials, options) })
        .where(
          and(
            eq(botSecret.userId, row.userId),
            eq(botSecret.name, row.name),
            eq(botSecret.encrypted, row.encrypted),
          ),
        )
        .returning({ name: botSecret.name });
      if (updated.length === 0) result.raced += 1;
      result.reencrypted += updated.length;
    }
    const last = rows.at(-1);
    if (!last || rows.length < batchSize) return result;
    after = { userId: last.userId, name: last.name };
  }
}

/**
 * Re-encrypts every Secret whose key isn't the keyring's first (ADR 0010), in batches, and counts
 * the rows no key can read, which stay in place.
 */
export async function rotateSecretKeys(
  sdk: BotSdkContext,
  { batchSize = 100 }: { batchSize?: number } = {},
) {
  const { reencrypted, unreadable } = await rotateInPasses(() => rotateOnce(sdk, batchSize));
  if (unreadable > 0)
    sdk.logger.error("Stored Secrets can't be read; left in place", { unreadable });
  return { reencrypted, unreadable };
}
