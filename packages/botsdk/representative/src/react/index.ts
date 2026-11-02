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
  return useQuery(useRepresentative().get.queryOptions({ input: { id } }));
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

/** Switches a Representative on or off (`representative.setEnabled`). */
export function useSetRepresentativeEnabled(
  options?: ProcedureMutationOptions<Representative["setEnabled"]>,
) {
  return useMutation(useRepresentative().setEnabled.mutationOptions(options));
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
