import type { FeatureContext } from "@botsdk/bot/feature";
import { parseInput, type WithUser } from "@botsdk/bot/rpc-error";
import {
  approveInput,
  customerAddIdentityInput,
  customerCreateInput,
  customerMergeInput,
  customerRenameInput,
  customerClearOptOutInput,
  customerSetBlockedInput,
  factAddInput,
  factEditInput,
  gapToFactInput,
  customerProfileSetInput,
  customerUpdateIdentityInput,
  profileFieldAddInput,
  profileFieldRenameInput,
  createInput,
  documentPickInput,
  documentRemoveInput,
  documentUploadInput,
  idInput,
  replyDraftEditInput,
  rollbackInput,
  setAssignmentDueInput,
  setBotInput,
  setCapsInput,
  setSpendingCapsInput,
  setQuietHoursInput,
  setEnabledInput,
  threadSendInput,
  topicAddInput,
  topicSetModeInput,
  updateDraftInput,
} from "../shared/contract";
import { type ConvertDocument, type KnowledgeFiles, knowledgeChoices } from "./documents";
import { addFact, deleteFact, editFact, listFactLog, listFacts } from "./facts";
import { dismissGap, gapToFact, listGaps } from "./gaps";
import { approveFactProposal, declineFactProposal, listFactProposals } from "./fact-proposals";
import { listMerges, mergeCustomers, undoMerge } from "./customer-merge";
import { deleteCustomer } from "./customer-delete";
import { listCustomerSummaries } from "./customer-summary";
import {
  addProfileField,
  listProfileFields,
  removeProfileField,
  renameProfileField,
} from "./customer-profile";
import {
  addIdentity,
  createCustomer,
  getThread,
  listCustomers,
  listThreads,
  renameCustomer,
  setProfileValue,
  clearOptOut,
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
  pickKnowledgeDocument,
  removeDocument,
  rollbackRelease,
  runTests,
  setAssignmentDue,
  setBot,
  setCaps,
  setEnabled,
  setSpendingCaps,
  setQuietHours,
  updateDraft,
  uploadDocument,
} from "./representatives";
import { type CustomerChannel, noCustomerChannel } from "./customer-proof";
import { dropHeldMessage, ownerInbox, sendHeldMessage } from "./held-messages";
import {
  approveReplyDraft,
  editReplyDraft,
  listReplyDrafts,
  rejectReplyDraft,
} from "./reply-drafts";
import { handBackThread, sendAsOwner, takeOverThread } from "./takeover";
import { addTopic, listTopics, removeTopic, setTopicMode } from "./topics";

/*
 * The `representative` namespace's domain methods: what a Host calls in-process as
 * `sdk.representative`, with the owner's id and no request. The HTTP layer serves the feature's
 * contract over them, passing the signed-in user's id.
 */

/** The `representative` namespace over the feature's context. */
export function representativeApi(
  base: FeatureContext<"assignments" | "factApprovals" | "models" | "releaseApprovals" | "threads">,
  convertDocument?: ConvertDocument,
  knowledgeFiles?: KnowledgeFiles,
  customerChannel: CustomerChannel = noCustomerChannel,
) {
  const context = { ...base, channel: customerChannel };
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

    /** Whether the owner can pick Knowledge files. Reads nothing, so it wakes no Computer. */
    knowledgeStatus: () => ({ available: knowledgeFiles !== undefined }),

    /** The Knowledge files the owner may pick, waking their Computer. */
    knowledgeList: async ({ userId }: { userId: string }) =>
      knowledgeChoices(knowledgeFiles, userId),

    documentPick: async ({ userId, ...rest }: WithUser<typeof documentPickInput>) => {
      const { id, path } = parseInput(documentPickInput, rest);
      return pickKnowledgeDocument(context, userId, id, path, knowledgeFiles);
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

    setCaps: async ({ userId, ...rest }: WithUser<typeof setCapsInput>) =>
      setCaps(context, userId, parseInput(setCapsInput, rest)),

    setSpendingCaps: async ({ userId, ...rest }: WithUser<typeof setSpendingCapsInput>) =>
      setSpendingCaps(context, userId, parseInput(setSpendingCapsInput, rest)),
    setQuietHours: async ({ userId, ...rest }: WithUser<typeof setQuietHoursInput>) =>
      setQuietHours(context, userId, parseInput(setQuietHoursInput, rest)),

    setAssignmentDue: async ({ userId, ...rest }: WithUser<typeof setAssignmentDueInput>) =>
      setAssignmentDue(context, userId, parseInput(setAssignmentDueInput, rest)),

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

    customerProfileSet: async ({ userId, ...rest }: WithUser<typeof customerProfileSetInput>) =>
      setProfileValue(context, userId, parseInput(customerProfileSetInput, rest)),

    profileFieldList: async ({ userId }: { userId: string }) => listProfileFields(context, userId),

    profileFieldAdd: async ({ userId, ...rest }: WithUser<typeof profileFieldAddInput>) =>
      addProfileField(context, userId, parseInput(profileFieldAddInput, rest).name),

    profileFieldRename: async ({ userId, ...rest }: WithUser<typeof profileFieldRenameInput>) =>
      renameProfileField(context, userId, parseInput(profileFieldRenameInput, rest)),

    profileFieldRemove: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      removeProfileField(context, userId, parseInput(idInput, rest).id),

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

    customerClearOptOut: async ({ userId, ...rest }: WithUser<typeof customerClearOptOutInput>) =>
      clearOptOut(context, userId, parseInput(customerClearOptOutInput, rest)),

    customerMerge: async ({ userId, ...rest }: WithUser<typeof customerMergeInput>) =>
      mergeCustomers(context, userId, parseInput(customerMergeInput, rest)),

    customerDelete: async ({ userId, ...rest }: WithUser<typeof idInput>) => {
      await deleteCustomer(context, userId, parseInput(idInput, rest).id);
    },

    customerSummaryList: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      listCustomerSummaries(context, userId, parseInput(idInput, rest).id),

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

    inbox: async ({ userId }: { userId: string }) => ownerInbox(context, userId),

    threadHeldSend: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      sendHeldMessage(context, userId, parseInput(idInput, rest).id),

    threadHeldDrop: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      dropHeldMessage(context, userId, parseInput(idInput, rest).id),

    threadSend: async ({ userId, ...rest }: WithUser<typeof threadSendInput>) =>
      sendAsOwner(context, userId, parseInput(threadSendInput, rest)),

    topicList: async ({ userId }: { userId: string }) => listTopics(context, userId),

    topicAdd: async ({ userId, ...rest }: WithUser<typeof topicAddInput>) =>
      addTopic(context, userId, parseInput(topicAddInput, rest).name),

    topicSetMode: async ({ userId, ...rest }: WithUser<typeof topicSetModeInput>) => {
      const { id, mode } = parseInput(topicSetModeInput, rest);
      return setTopicMode(context, userId, id, mode);
    },

    topicRemove: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      removeTopic(context, userId, parseInput(idInput, rest).id),

    replyDraftList: async ({ userId }: { userId: string }) => listReplyDrafts(context, userId),

    replyDraftApprove: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      approveReplyDraft(context, userId, parseInput(idInput, rest).id),

    replyDraftEdit: async ({ userId, ...rest }: WithUser<typeof replyDraftEditInput>) => {
      const { id, text } = parseInput(replyDraftEditInput, rest);
      return editReplyDraft(context, userId, id, text);
    },

    replyDraftReject: async ({ userId, ...rest }: WithUser<typeof idInput>) =>
      rejectReplyDraft(context, userId, parseInput(idInput, rest).id),
  };
}

/** The `representative` feature's API (`sdk.representative`). */
export type RepresentativeApi = ReturnType<typeof representativeApi>;
