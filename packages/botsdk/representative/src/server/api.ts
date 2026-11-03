import type { FeatureContext } from "@botsdk/bot/feature";
import { parseInput, type WithUser } from "@botsdk/bot/rpc-error";
import {
  approveInput,
  customerAddIdentityInput,
  customerCreateInput,
  customerRenameInput,
  customerSetBlockedInput,
  customerUpdateIdentityInput,
  createInput,
  idInput,
  rollbackInput,
  setBotInput,
  setEnabledInput,
  updateDraftInput,
} from "../shared/contract";
import {
  addIdentity,
  createCustomer,
  getThread,
  listCustomers,
  listThreads,
  renameCustomer,
  setBlocked,
  updateIdentity,
} from "./owner-customers";
import {
  approveDraft,
  createRepresentative,
  declineApproval,
  diffDraft,
  getRepresentative,
  listRepresentatives,
  rollbackRelease,
  runTests,
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
export function representativeApi(
  context: FeatureContext<"assignments" | "models" | "releaseApprovals" | "threads">,
) {
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

    runTests: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      runTests(context, userId, parseInput(idInput, rest).id),

    approve: async ({ userId, ...rest }: WithUser<typeof approveInput>) => {
      const { id, overrideReason } = parseInput(approveInput, rest);
      return approveDraft(context, userId, id, overrideReason);
    },

    declineApproval: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      declineApproval(context, userId, parseInput(idInput, rest).id),

    diff: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      diffDraft(context, userId, parseInput(idInput, rest).id),

    rollback: async ({ userId, ...rest }: WithUser<typeof rollbackInput>) => {
      const { id, releaseId } = parseInput(rollbackInput, rest);
      return rollbackRelease(context, userId, id, releaseId);
    },

    setEnabled: async ({ userId, ...rest }: WithUser<typeof setEnabledInput>) => {
      const { id, enabled } = parseInput(setEnabledInput, rest);
      return setEnabled(context, userId, id, enabled);
    },

    setBot: async ({ userId, ...rest }: WithUser<typeof setBotInput>) => {
      const { id, botId } = parseInput(setBotInput, rest);
      return setBot(context, userId, id, botId);
    },

    customerList: async ({ userId }: { userId: string }) => listCustomers(context, userId),

    customerCreate: async ({ userId, ...rest }: WithUser<typeof customerCreateInput>) =>
      createCustomer(context, userId, parseInput(customerCreateInput, rest)),

    customerRename: async ({ userId, ...rest }: WithUser<typeof customerRenameInput>) => {
      const { id, name } = parseInput(customerRenameInput, rest);
      return renameCustomer(context, userId, id, name);
    },

    customerAddIdentity: async ({ userId, ...rest }: WithUser<typeof customerAddIdentityInput>) =>
      addIdentity(context, userId, parseInput(customerAddIdentityInput, rest)),

    customerUpdateIdentity: async ({
      userId,
      ...rest
    }: WithUser<typeof customerUpdateIdentityInput>) =>
      updateIdentity(context, userId, parseInput(customerUpdateIdentityInput, rest)),

    customerSetBlocked: async ({ userId, ...rest }: WithUser<typeof customerSetBlockedInput>) => {
      const { id, blocked } = parseInput(customerSetBlockedInput, rest);
      return setBlocked(context, userId, id, blocked, context.clock());
    },

    threadList: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      listThreads(context, userId, parseInput(idInput, rest).id),

    threadGet: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      getThread(context, userId, parseInput(idInput, rest).id),
  };
}

/** The `representative` feature's API (`sdk.representative`). */
export type RepresentativeApi = ReturnType<typeof representativeApi>;
