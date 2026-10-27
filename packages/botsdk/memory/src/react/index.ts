import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type ProcedureMutationOptions, useOrpc } from "@botsdk/react/provider";
import type { MemoryContract, MemoryFileRef } from "../shared/contract";

/*
 * The `memory` feature's hooks (spec #875): TanStack Query over its procedures, for a UI inside a
 * `<BotSdkProvider>` whose client has `memoryClient()`. A mutation hook takes the procedure's
 * mutation options (`onSuccess`, `onError`…); the refresh hooks refetch what a change makes stale.
 */

function useMemory() {
  return useOrpc<{ memory: MemoryContract }>().memory;
}

type Memory = ReturnType<typeof useMemory>;

/** The user's Memory switch, and whether Bots can have memory (`memory.status`). */
export function useMemoryStatus() {
  return useQuery(useMemory().status.queryOptions());
}

/** Turns the user's Memory switch on or off (`memory.setEnabled`). */
export function useSetMemoryEnabled(options?: ProcedureMutationOptions<Memory["setEnabled"]>) {
  return useMutation(useMemory().setEnabled.mutationOptions(options));
}

/** Refetches the Memory switch after it changed. */
export function useRefreshMemoryStatus() {
  const memory = useMemory();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: memory.status.queryKey() });
}

/** Bot `botId`'s Profile, Log and Notes lines (`memory.botList`), read while `enabled`. */
export function useBotMemory(botId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...useMemory().botList.queryOptions({ input: { botId } }), enabled });
}

/** One memory file's raw text (`memory.botReadFile`). */
export function useBotMemoryFile(file: MemoryFileRef) {
  return useQuery(useMemory().botReadFile.queryOptions({ input: { file } }));
}

/** Adds a line to a Bot's Profile, Log or Notes (`memory.botAddLine`). */
export function useAddBotMemoryLine(options?: ProcedureMutationOptions<Memory["botAddLine"]>) {
  return useMutation(useMemory().botAddLine.mutationOptions(options));
}

/** Changes one line of a memory file (`memory.botEditLine`). */
export function useEditBotMemoryLine(options?: ProcedureMutationOptions<Memory["botEditLine"]>) {
  return useMutation(useMemory().botEditLine.mutationOptions(options));
}

/** Deletes one line of a memory file (`memory.botDeleteLine`). */
export function useDeleteBotMemoryLine(
  options?: ProcedureMutationOptions<Memory["botDeleteLine"]>,
) {
  return useMutation(useMemory().botDeleteLine.mutationOptions(options));
}

/** Writes a memory file whole, refused when it changed since it was read (`memory.botSaveFile`). */
export function useSaveBotMemoryFile(options?: ProcedureMutationOptions<Memory["botSaveFile"]>) {
  return useMutation(useMemory().botSaveFile.mutationOptions(options));
}

/** Refetches the Bots' memory lines and files after a change to their files. */
export function useRefreshBotMemory() {
  const memory = useMemory();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: memory.botList.key() }),
      queryClient.invalidateQueries({ queryKey: memory.botReadFile.key() }),
    ]);
}
