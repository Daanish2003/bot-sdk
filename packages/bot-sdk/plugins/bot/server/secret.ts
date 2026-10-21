import { asc, eq, and } from "drizzle-orm";

import { encryptCredentials } from "../../../core/server/credentials/encryption";
import { botSecret } from "../../../core/server/db/schema";
import type { Database } from "../../../core/server/db/index";
import { rpcError } from "../../../core/server/rpc-error";
import type { BotSdkContext } from "../../../core/server/plugin";
import type { BotSecret } from "../shared/secret";
import { secretEncryption } from "./secret-values";
import { hintChanged } from "./turn";
import { receive } from "./router";
import { findBot } from "./store";

/** The Trigger text that wakes the Bot once the user saved Secret `name`: the name, never the value. */
export const savedSecretText = (name: string) => `Saved secret ${name}`;

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
  { botId, name, value }: { botId: string; name: string; value: string },
): Promise<void> {
  const found = await findBot(sdk.db, userId, botId);
  if (!found) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
  // Like a Message, the save wakes the Bot, so it is refused while the Bot can't run on its Model.
  const call = await sdk.plugin("models").resolveModelCall(userId, found.model);
  if (!call) {
    throw rpcError(
      "BAD_REQUEST",
      "error.modelNotAvailable",
      `"${found.model}" is not an available Model`,
      { model: found.model },
    );
  }
  if (!(await call.meter.mayRun()).ok) {
    throw rpcError("PAYMENT_REQUIRED", "error.quotaSpent", "You've used this window's Quota");
  }
  const encrypted = encryptCredentials({ value }, secretEncryption(sdk, userId, name));
  const now = sdk.clock();
  await sdk.db.transaction(async (tx) => {
    await tx
      .insert(botSecret)
      .values({ userId, name, encrypted, createdAt: now })
      .onConflictDoUpdate({
        target: [botSecret.userId, botSecret.name],
        set: { encrypted, createdAt: now },
      });
    await receive(sdk, tx, {
      id: savedTriggerId(userId, name, now),
      conversationId: found.conversationId,
      source: "user",
      channel: "web",
      text: savedSecretText(name),
      receivedAt: now,
    });
  });
  sdk.plugin("runner").wake();
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

/** Deletes the user's Secret `name`. Deleting one that isn't there does nothing. */
export async function deleteSecret(db: Database, userId: string, name: string): Promise<void> {
  await db.delete(botSecret).where(and(eq(botSecret.userId, userId), eq(botSecret.name, name)));
}
