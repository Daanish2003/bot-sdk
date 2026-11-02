import type { FeatureContext } from "@botsdk/bot/feature";
import { parseInput, type WithUser } from "@botsdk/bot/rpc-error";
import {
  createInput,
  idInput,
  setBotInput,
  setEnabledInput,
  updateDraftInput,
} from "../shared/contract";
import {
  approveDraft,
  createRepresentative,
  getRepresentative,
  listRepresentatives,
  setBot,
  setEnabled,
  updateDraft,
} from "./representatives";

/*
 * The `representative` namespace's domain methods: what a Host calls in-process as
 * `sdk.representative`, with the owner's id and no request. The HTTP layer serves the feature's
 * contract over them, passing the signed-in user's id.
 */

/** The `representative` namespace over the feature's context. */
export function representativeApi(context: FeatureContext<"assignments">) {
  return {
    list: async ({ userId }: { userId: string }) => listRepresentatives(context, userId),

    get: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      getRepresentative(context, userId, parseInput(idInput, rest).id),

    create: async ({ userId, ...rest }: WithUser<typeof createInput>) =>
      createRepresentative(context, userId, parseInput(createInput, rest)),

    updateDraft: async ({ userId, ...rest }: WithUser<typeof updateDraftInput>) => {
      const { id, draft } = parseInput(updateDraftInput, rest);
      return updateDraft(context, userId, id, draft);
    },

    approve: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      approveDraft(context, userId, parseInput(idInput, rest).id),

    setEnabled: async ({ userId, ...rest }: WithUser<typeof setEnabledInput>) => {
      const { id, enabled } = parseInput(setEnabledInput, rest);
      return setEnabled(context, userId, id, enabled);
    },

    setBot: async ({ userId, ...rest }: WithUser<typeof setBotInput>) => {
      const { id, botId } = parseInput(setBotInput, rest);
      return setBot(context, userId, id, botId);
    },
  };
}

/** The `representative` feature's API (`sdk.representative`). */
export type RepresentativeApi = ReturnType<typeof representativeApi>;
