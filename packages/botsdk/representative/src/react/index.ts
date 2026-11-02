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

/** Approves the draft into a Release (`representative.approve`). */
export function useApproveRelease(options?: ProcedureMutationOptions<Representative["approve"]>) {
  return useMutation(useRepresentative().approve.mutationOptions(options));
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

/** Refetches everything the `representative` feature read, after a change. */
export function useRefreshRepresentatives() {
  const representative = useRepresentative();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: representative.key() });
}
