import type { FeatureContext } from "@botsdk/bot/feature";
import { parseInput, type WithUser } from "@botsdk/bot/rpc-error";
import {
  approveInput,
  customerAddIdentityInput,
  customerCreateInput,
  customerMergeInput,
  customerRenameInput,
  customerSetBlockedInput,
  factAddInput,
  factEditInput,
  gapToFactInput,
  customerUpdateIdentityInput,
  createInput,
  documentRemoveInput,
  documentUploadInput,
  idInput,
  rollbackInput,
  setBotInput,
  setEnabledInput,
  threadSendInput,
  updateDraftInput,
} from "../shared/contract";
import type { ConvertDocument } from "./documents";
import { addFact, deleteFact, editFact, listFactLog, listFacts } from "./facts";
import { dismissGap, gapToFact, listGaps } from "./gaps";
import { approveFactProposal, declineFactProposal, listFactProposals } from "./fact-proposals";
import { listMerges, mergeCustomers, undoMerge } from "./customer-merge";
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
  removeDocument,
  rollbackRelease,
  runTests,
  setBot,
  setEnabled,
  updateDraft,
  uploadDocument,
} from "./representatives";
import { handBackThread, sendAsOwner, takeOverThread } from "./takeover";

/*
 * The `representative` namespace's domain methods: what a Host calls in-process as
 * `sdk.representative`, with the owner's id and no request. The HTTP layer serves the feature's
 * contract over them, passing the signed-in user's id.
 */

/** The `representative` namespace over the feature's context. */
export function representativeApi(
  context: FeatureContext<
    "assignments" | "factApprovals" | "models" | "releaseApprovals" | "threads"
  >,
  convertDocument?: ConvertDocument,
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

    documentUpload: async ({ userId, ...rest }: WithUser<typeof documentUploadInput>) => {
      const { id, file } = parseInput(documentUploadInput, rest);
      return uploadDocument(context, userId, id, file, convertDocument);
    },

    documentRemove: async ({ userId, ...rest }: WithUser<typeof documentRemoveInput>) => {
      const { id, documentId } = parseInput(documentRemoveInput, rest);
      return removeDocument(context, userId, id, documentId);
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

    customerMerge: async ({ userId, ...rest }: WithUser<typeof customerMergeInput>) =>
      mergeCustomers(context, userId, parseInput(customerMergeInput, rest)),

    customerMergeList: async ({ userId }: { userId: string }) => listMerges(context, userId),

    customerMergeUndo: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      undoMerge(context, userId, parseInput(idInput, rest).id),

    factList: async ({ userId }: { userId: string }) => listFacts(context, userId),

    factAdd: async ({ userId, ...rest }: WithUser<typeof factAddInput>) =>
      addFact(context, userId, parseInput(factAddInput, rest)),

    factEdit: async ({ userId, ...rest }: WithUser<typeof factEditInput>) =>
      editFact(context, userId, parseInput(factEditInput, rest)),

    factDelete: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      deleteFact(context, userId, parseInput(idInput, rest).id),

    factLog: async ({ userId }: { userId: string }) => listFactLog(context, userId),

    gapList: async ({ userId }: { userId: string }) => listGaps(context, userId),

    gapDismiss: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      dismissGap(context, userId, parseInput(idInput, rest).id),

    gapToFact: async ({ userId, ...rest }: WithUser<typeof gapToFactInput>) =>
      gapToFact(context, userId, parseInput(gapToFactInput, rest)),
    factProposals: async ({ userId }: { userId: string }) => listFactProposals(context, userId),

    factProposalApprove: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      approveFactProposal(context, userId, parseInput(idInput, rest).id),

    factProposalDecline: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      declineFactProposal(context, userId, parseInput(idInput, rest).id),

    threadList: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      listThreads(context, userId, parseInput(idInput, rest).id),

    threadGet: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      getThread(context, userId, parseInput(idInput, rest).id),

    threadTakeOver: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      takeOverThread(context, userId, parseInput(idInput, rest).id),

    threadHandBack: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      handBackThread(context, userId, parseInput(idInput, rest).id),

    threadSend: async ({ userId, ...rest }: WithUser<typeof threadSendInput>) =>
      sendAsOwner(context, userId, parseInput(threadSendInput, rest)),
  };
}

/** The `representative` feature's API (`sdk.representative`). */
export type RepresentativeApi = ReturnType<typeof representativeApi>;
