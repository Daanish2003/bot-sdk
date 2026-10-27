import { saveSecretInput, deleteSecretInput } from "@botsdk/client/bot/contract";

import type { BotSdkContext } from "../plugin";
import { parseInput, type WithUser } from "../rpc-error";
import { deleteSecret, listSecrets, saveSecret } from "./safety";

/*
 * The `secrets` namespace's domain methods (spec #873): the user's Secrets, shared by all their
 * Bots. A value goes in through `save` and never comes out: `list` returns names and dates only.
 * Each takes one object with `userId`; the procedures are one-line wrappers.
 */

/** The `secrets` namespace over the core context. */
export function secretsApi(sdk: BotSdkContext) {
  return {
    /**
     * Saves Secret `name`, encrypted, replacing an earlier one, and wakes the Bot `botId` with the
     * Trigger "Saved secret NAME". The value never enters the Conversation. Another user's Bot is
     * not found.
     */
    save: async ({ userId, ...rest }: WithUser<typeof saveSecretInput>) =>
      saveSecret(sdk, userId, parseInput(saveSecretInput, rest)),

    /** The user's Secrets, by name, each with when it was saved. Never a value. */
    list: async ({ userId }: { userId: string }) => listSecrets(sdk.db, userId),

    /** Deletes the user's Secret `name`; one that isn't there does nothing. */
    delete: async ({ userId, ...rest }: WithUser<typeof deleteSecretInput>) =>
      deleteSecret(sdk, userId, parseInput(deleteSecretInput, rest).name),
  };
}

/** The `secrets` namespace's domain methods. */
export type SecretsApi = ReturnType<typeof secretsApi>;
