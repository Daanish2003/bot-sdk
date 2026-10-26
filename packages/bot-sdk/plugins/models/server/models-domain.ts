import { z } from "zod";

import { parseInput, rpcError, type WithUser } from "../../../core/server/rpc-error";
import { listAvailableModels } from "./available-models";
import { checkCredentials } from "./credentials/check";
import { shownLinkedPlan } from "./credentials/resolve";
import {
  deleteCredentials,
  listCredentials,
  loadCredentials,
  saveCredentials,
} from "./credentials/store";
import { loadImageModelSetting, saveImageModelSetting } from "./image-model-setting";
import { resolveImageModel } from "./image-models";
import type { ModelsDeps } from "./types";
import {
  credentialHint,
  type OpenaiCredentialsState,
  saveCredentialsInput,
} from "../shared/credentials/services";
import { deleteCredentialsInput, setImageModelInput } from "../shared/contract";

/*
 * The `models` namespace's domain methods besides the older ones (spec #873): what a Host calls
 * in-process, with the user's id and no request. Each takes one object with `userId`; the
 * procedures of `routers/` are one-line wrappers that pass the signed-in user's id. Each input
 * schema is the one its procedure validates with.
 */

/** The `models` namespace's domain methods over the Models' dependencies. */
export function modelsDomain(deps: ModelsDeps) {
  return {
    /** The Models of Providers the user has credentials for, and a new Conversation's default. */
    list: ({ userId }: { userId: string }) => listAvailableModels(deps, userId),

    /** The user's Image Model pick, or `null` for the Host's default. */
    imageModel: async ({ userId }: { userId: string }) => ({
      imageModel: await loadImageModelSetting(deps, userId),
    }),

    /**
     * Chooses the Image Model Generated images are made with; `null` is the Host's default. The
     * Model must be one the user can use: a curated Image Model of a Provider they have credentials
     * for, or one of the Host's Image Models (spec #278).
     */
    setImageModel: async ({ userId, ...rest }: WithUser<typeof setImageModelInput>) => {
      const { imageModel } = parseInput(setImageModelInput, rest);
      if (imageModel !== null && !(await resolveImageModel(deps, userId, imageModel))) {
        throw rpcError(
          "BAD_REQUEST",
          "error.imageModelNotAvailable",
          `"${imageModel}" is not an available Image Model`,
          { model: imageModel },
        );
      }
      await saveImageModelSetting(deps, userId, imageModel);
    },

    /** The user's Provider credentials and Tool credentials. Write-only: only hints come out (ADR 0003). */
    credentials: {
      /** The user's saved services, each with its hint and whether it was verified. */
      list: ({ userId }: { userId: string }) => listCredentials(deps, userId),

      /**
       * The OpenAI row's state on the Keys page (ADR 0023): a saved key wins, then the Host's linked
       * ChatGPT plan (linked, or needing a reconnect), else none. With `byok` off neither is used.
       */
      openaiState: async ({ userId }: { userId: string }): Promise<OpenaiCredentialsState> => {
        if (!deps.byok) return "none";
        if (await loadCredentials(deps, userId, "openai")) return "key";
        const linked = await shownLinkedPlan(deps, userId);
        if (!linked) return "none";
        return linked === "needs-reconnect" ? "needs-reconnect" : "linked";
      },

      /**
       * Checks and saves the user's credentials for a service, encrypted, replacing earlier ones, and
       * returns the service's hint. Refused when `byok` is off, and when the service rejects them.
       */
      save: async ({
        userId,
        ...rest
      }: { userId: string } & z.input<typeof saveCredentialsInput>) => {
        const input = parseInput(saveCredentialsInput, rest);
        if (!deps.byok) {
          throw rpcError("FORBIDDEN", "error.byokOff", "Your own keys are turned off on this app");
        }
        // The user's Ollama host is not guarded (see `ModelsDeps.ollamaFetch`).
        const fetch = input.service === "ollama" ? deps.ollamaFetch : deps.fetch;
        const result = await checkCredentials(input.service, input.fields, fetch);
        if (result.status === "rejected") {
          throw rpcError("BAD_REQUEST", result.code, result.message, result.params, {
            reason: result.reason,
          });
        }
        const summary = {
          service: input.service,
          hint: credentialHint(input.fields),
          verified: result.status === "verified",
        };
        await saveCredentials(deps, userId, { ...summary, fields: input.fields });
        return summary;
      },

      /** Deletes the user's credentials for a service. */
      delete: async ({ userId, ...rest }: WithUser<typeof deleteCredentialsInput>) => {
        await deleteCredentials(deps, userId, parseInput(deleteCredentialsInput, rest).service);
      },
    },
  };
}

/** The `models` namespace's domain methods. */
export type ModelsDomain = ReturnType<typeof modelsDomain>;
