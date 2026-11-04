import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type ProcedureMutationOptions, useOrpc } from "@botsdk/react/provider";
import type { RepresentativeContract } from "../shared/contract";

/*
 * The `representative` feature's hooks: TanStack Query over its procedures, for a UI inside a
 * `<BotSdkProvider>` whose client has `representativeClient()`. A mutation hook takes the
 * procedure's mutation options (`onSuccess`, `onError`…); the refresh hook refetches what a change
 * makes stale.
 */

function useRepresentative() {
  return useOrpc<{ representative: RepresentativeContract }>().representative;
}

type Representative = ReturnType<typeof useRepresentative>;

/** The owner's Representatives (`representative.list`). */
export function useRepresentatives() {
  return useQuery(useRepresentative().list.queryOptions());
}

/** One Representative with its draft and Releases (`representative.get`). */
export function useRepresentativeDetail(id: string) {
  return useQuery({
    ...useRepresentative().get.queryOptions({ input: { id } }),
    // While its tests run, the page watches for their results.
    refetchInterval: (query) =>
      query.state.data?.tests.some((test) => test.status === "queued" || test.status === "running")
        ? 1_000
        : false,
  });
}

/** Creates a Representative (`representative.create`). */
export function useCreateRepresentative(
  options?: ProcedureMutationOptions<Representative["create"]>,
) {
  return useMutation(useRepresentative().create.mutationOptions(options));
}

/** Changes the draft (`representative.updateDraft`). */
export function useUpdateDraft(options?: ProcedureMutationOptions<Representative["updateDraft"]>) {
  return useMutation(useRepresentative().updateDraft.mutationOptions(options));
}

/** Adds a document to the draft (`representative.documentUpload`). */
export function useUploadDocument(
  options?: ProcedureMutationOptions<Representative["documentUpload"]>,
) {
  return useMutation(useRepresentative().documentUpload.mutationOptions(options));
}

/** Whether Knowledge files can be picked (`representative.knowledgeStatus`). */
export function useKnowledgeStatus() {
  return useQuery(useRepresentative().knowledgeStatus.queryOptions());
}

/** The Knowledge files that can be picked, read only once `enabled` (`representative.knowledgeList`). */
export function useKnowledgeChoices(enabled: boolean) {
  return useQuery({ ...useRepresentative().knowledgeList.queryOptions(), enabled, retry: false });
}

/** Copies a Knowledge file into the draft (`representative.documentPick`). */
export function usePickKnowledge(
  options?: ProcedureMutationOptions<Representative["documentPick"]>,
) {
  return useMutation(useRepresentative().documentPick.mutationOptions(options));
}

/** Takes a document out of the draft (`representative.documentRemove`). */
export function useRemoveDocument(
  options?: ProcedureMutationOptions<Representative["documentRemove"]>,
) {
  return useMutation(useRepresentative().documentRemove.mutationOptions(options));
}

/** Approves the draft into a Release (`representative.approve`). */
export function useApproveRelease(options?: ProcedureMutationOptions<Representative["approve"]>) {
  return useMutation(useRepresentative().approve.mutationOptions(options));
}

/** Says no to a Bot's draft (`representative.declineApproval`). */
export function useDeclineApproval(
  options?: ProcedureMutationOptions<Representative["declineApproval"]>,
) {
  return useMutation(useRepresentative().declineApproval.mutationOptions(options));
}

/** Runs the draft's test conversations (`representative.runTests`). */
export function useRunTests(options?: ProcedureMutationOptions<Representative["runTests"]>) {
  return useMutation(useRepresentative().runTests.mutationOptions(options));
}

/** Goes back to an earlier Release (`representative.rollback`). */
export function useRollbackRelease(options?: ProcedureMutationOptions<Representative["rollback"]>) {
  return useMutation(useRepresentative().rollback.mutationOptions(options));
}

/** What the draft changes against the live Release (`representative.diff`). */
export function useDraftDiff(id: string) {
  return useQuery(useRepresentative().diff.queryOptions({ input: { id } }));
}

/** Switches a Representative on or off (`representative.setEnabled`). */
export function useSetRepresentativeEnabled(
  options?: ProcedureMutationOptions<Representative["setEnabled"]>,
) {
  return useMutation(useRepresentative().setEnabled.mutationOptions(options));
}

/** Edits the caps on what the Outbound gate sends a Customer (`representative.setCaps`). */
export function useSetRepresentativeCaps(
  options?: ProcedureMutationOptions<Representative["setCaps"]>,
) {
  return useMutation(useRepresentative().setCaps.mutationOptions(options));
}

/** Edits the hours the Outbound gate holds what the business starts (`representative.setQuietHours`). */
export function useSetRepresentativeQuietHours(
  options?: ProcedureMutationOptions<Representative["setQuietHours"]>,
) {
  return useMutation(useRepresentative().setQuietHours.mutationOptions(options));
}

/** Chooses the Bot a Representative reports to (`representative.setBot`). */
export function useSetRepresentativeBot(
  options?: ProcedureMutationOptions<Representative["setBot"]>,
) {
  return useMutation(useRepresentative().setBot.mutationOptions(options));
}

/** Refetches everything the `representative` feature read, after a change. */
export function useRefreshRepresentatives() {
  const representative = useRepresentative();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: representative.key() });
}

/** The owner's Customers (`representative.customerList`). */
export function useCustomers() {
  return useQuery(useRepresentative().customerList.queryOptions());
}

/** Adds a Customer by hand (`representative.customerCreate`). */
export function useCreateCustomer(
  options?: ProcedureMutationOptions<Representative["customerCreate"]>,
) {
  return useMutation(useRepresentative().customerCreate.mutationOptions(options));
}

/** Names a Customer (`representative.customerRename`). */
export function useRenameCustomer(
  options?: ProcedureMutationOptions<Representative["customerRename"]>,
) {
  return useMutation(useRepresentative().customerRename.mutationOptions(options));
}

/** Sets or clears a Customer's profile value (`representative.customerProfileSet`). */
export function useSetCustomerProfileValue(
  options?: ProcedureMutationOptions<Representative["customerProfileSet"]>,
) {
  return useMutation(useRepresentative().customerProfileSet.mutationOptions(options));
}

/** The owner's own profile fields (`representative.profileFieldList`). */
export function useProfileFields() {
  return useQuery(useRepresentative().profileFieldList.queryOptions());
}

/** Adds a profile field (`representative.profileFieldAdd`). */
export function useAddProfileField(
  options?: ProcedureMutationOptions<Representative["profileFieldAdd"]>,
) {
  return useMutation(useRepresentative().profileFieldAdd.mutationOptions(options));
}

/** Renames a profile field (`representative.profileFieldRename`). */
export function useRenameProfileField(
  options?: ProcedureMutationOptions<Representative["profileFieldRename"]>,
) {
  return useMutation(useRepresentative().profileFieldRename.mutationOptions(options));
}

/** Removes a profile field and its values (`representative.profileFieldRemove`). */
export function useRemoveProfileField(
  options?: ProcedureMutationOptions<Representative["profileFieldRemove"]>,
) {
  return useMutation(useRepresentative().profileFieldRemove.mutationOptions(options));
}

/** Gives a Customer another identity (`representative.customerAddIdentity`). */
export function useAddCustomerIdentity(
  options?: ProcedureMutationOptions<Representative["customerAddIdentity"]>,
) {
  return useMutation(useRepresentative().customerAddIdentity.mutationOptions(options));
}

/** Corrects one identity of a Customer (`representative.customerUpdateIdentity`). */
export function useUpdateCustomerIdentity(
  options?: ProcedureMutationOptions<Representative["customerUpdateIdentity"]>,
) {
  return useMutation(useRepresentative().customerUpdateIdentity.mutationOptions(options));
}

/** Blocks or unblocks a Customer (`representative.customerSetBlocked`). */
export function useSetCustomerBlocked(
  options?: ProcedureMutationOptions<Representative["customerSetBlocked"]>,
) {
  return useMutation(useRepresentative().customerSetBlocked.mutationOptions(options));
}

/** Merges one Customer into another (`representative.customerMerge`). */
export function useMergeCustomer(
  options?: ProcedureMutationOptions<Representative["customerMerge"]>,
) {
  return useMutation(useRepresentative().customerMerge.mutationOptions(options));
}

/** Deletes a Customer for good (`representative.customerDelete`). */
export function useDeleteCustomer(
  options?: ProcedureMutationOptions<Representative["customerDelete"]>,
) {
  return useMutation(useRepresentative().customerDelete.mutationOptions(options));
}

/** What the pass wrote for a Customer's closed threads (`representative.customerSummaryList`). */
export function useCustomerSummaries(id: string) {
  return useQuery(useRepresentative().customerSummaryList.queryOptions({ input: { id } }));
}

/** The owner's merges of Customers (`representative.customerMergeList`). */
export function useCustomerMerges() {
  return useQuery(useRepresentative().customerMergeList.queryOptions());
}

/** Undoes a merge (`representative.customerMergeUndo`). */
export function useUndoCustomerMerge(
  options?: ProcedureMutationOptions<Representative["customerMergeUndo"]>,
) {
  return useMutation(useRepresentative().customerMergeUndo.mutationOptions(options));
}

/** The owner's Published facts (`representative.factList`). */
export function useFacts() {
  return useQuery(useRepresentative().factList.queryOptions());
}

/** The log of changes to the owner's facts (`representative.factLog`). */
export function useFactLog() {
  return useQuery(useRepresentative().factLog.queryOptions());
}

/** Adds a fact (`representative.factAdd`). */
export function useAddFact(options?: ProcedureMutationOptions<Representative["factAdd"]>) {
  return useMutation(useRepresentative().factAdd.mutationOptions(options));
}

/** Edits a fact (`representative.factEdit`). */
export function useEditFact(options?: ProcedureMutationOptions<Representative["factEdit"]>) {
  return useMutation(useRepresentative().factEdit.mutationOptions(options));
}

/** The facts the owner's Bots have proposed that still wait (`representative.factProposals`). */
export function useFactProposals() {
  // Nothing tells this page a Bot proposed, and a card's link must find what it links to.
  return useQuery({
    ...useRepresentative().factProposals.queryOptions(),
    refetchOnMount: "always",
  });
}

/** Approves a Bot's proposed fact (`representative.factProposalApprove`). */
export function useApproveFactProposal(
  options?: ProcedureMutationOptions<Representative["factProposalApprove"]>,
) {
  return useMutation(useRepresentative().factProposalApprove.mutationOptions(options));
}

/** Declines a Bot's proposed fact (`representative.factProposalDecline`). */
export function useDeclineFactProposal(
  options?: ProcedureMutationOptions<Representative["factProposalDecline"]>,
) {
  return useMutation(useRepresentative().factProposalDecline.mutationOptions(options));
}

/** Deletes a fact (`representative.factDelete`). */
export function useDeleteFact(options?: ProcedureMutationOptions<Representative["factDelete"]>) {
  return useMutation(useRepresentative().factDelete.mutationOptions(options));
}

/** The owner's open Gaps (`representative.gapList`). */
export function useGaps() {
  return useQuery(useRepresentative().gapList.queryOptions());
}

/** Dismisses a Gap (`representative.gapDismiss`). */
export function useDismissGap(options?: ProcedureMutationOptions<Representative["gapDismiss"]>) {
  return useMutation(useRepresentative().gapDismiss.mutationOptions(options));
}

/** Turns a Gap into a fact, closing it (`representative.gapToFact`). */
export function useGapToFact(options?: ProcedureMutationOptions<Representative["gapToFact"]>) {
  return useMutation(useRepresentative().gapToFact.mutationOptions(options));
}

/** A Representative's Customer threads (`representative.threadList`). */
export function useThreads(id: string) {
  return useQuery(useRepresentative().threadList.queryOptions({ input: { id } }));
}

/** One thread with its transcript (`representative.threadGet`). */
export function useThread(id: string) {
  return useQuery(useRepresentative().threadGet.queryOptions({ input: { id } }));
}

/** Takes a thread over from its Representative (`representative.threadTakeOver`). */
export function useTakeOverThread(
  options?: ProcedureMutationOptions<Representative["threadTakeOver"]>,
) {
  return useMutation(useRepresentative().threadTakeOver.mutationOptions(options));
}

/** Hands a thread back to its Representative (`representative.threadHandBack`). */
export function useHandBackThread(
  options?: ProcedureMutationOptions<Representative["threadHandBack"]>,
) {
  return useMutation(useRepresentative().threadHandBack.mutationOptions(options));
}

/** The owner's own message on a thread they hold (`representative.threadSend`). */
export function useSendThreadMessage(
  options?: ProcedureMutationOptions<Representative["threadSend"]>,
) {
  return useMutation(useRepresentative().threadSend.mutationOptions(options));
}
