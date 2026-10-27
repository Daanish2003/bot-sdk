import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type ProcedureMutationOptions, useOrpc } from "@botsdk/react/provider";
import type { KnowledgeContract } from "../shared/contract";

/*
 * The `knowledge` feature's hooks (spec #875): TanStack Query over its procedures, for a UI inside a
 * `<BotSdkProvider>` whose client has `knowledgeClient()`. A mutation hook takes the procedure's
 * mutation options (`onSuccess`, `onError`…); the refresh hook refetches what a change makes stale.
 */

function useKnowledge() {
  return useOrpc<{ knowledge: KnowledgeContract }>().knowledge;
}

type Knowledge = ReturnType<typeof useKnowledge>;

/** Whether the user can have Knowledge (`knowledge.status`). */
export function useKnowledgeStatus() {
  return useQuery(useKnowledge().status.queryOptions());
}

/** The user's Knowledge: its folders, files and usage (`knowledge.list`), read while `enabled`. */
export function useKnowledgeList({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...useKnowledge().list.queryOptions(), enabled });
}

/** Reads the Knowledge list now, from the cache when it holds it (`knowledge.list`). */
export function useLoadKnowledgeList() {
  const knowledge = useKnowledge();
  const queryClient = useQueryClient();
  return () => queryClient.ensureQueryData(knowledge.list.queryOptions());
}

/** One Knowledge file's text and size (`knowledge.read`). */
export function useKnowledgeFile(path: string) {
  return useQuery(useKnowledge().read.queryOptions({ input: { path } }));
}

/** Saves a text file to Knowledge (`knowledge.upload`). */
export function useUploadKnowledge(options?: ProcedureMutationOptions<Knowledge["upload"]>) {
  return useMutation(useKnowledge().upload.mutationOptions(options));
}

/** Saves a PDF or DOCX to Knowledge, with its readable text (`knowledge.uploadDocument`). */
export function useUploadKnowledgeDocument(
  options?: ProcedureMutationOptions<Knowledge["uploadDocument"]>,
) {
  return useMutation(useKnowledge().uploadDocument.mutationOptions(options));
}

/** Deletes a Knowledge file or folder (`knowledge.remove`). */
export function useDeleteKnowledge(options?: ProcedureMutationOptions<Knowledge["remove"]>) {
  return useMutation(useKnowledge().remove.mutationOptions(options));
}

/** Makes a Knowledge folder (`knowledge.createFolder`). */
export function useCreateKnowledgeFolder(
  options?: ProcedureMutationOptions<Knowledge["createFolder"]>,
) {
  return useMutation(useKnowledge().createFolder.mutationOptions(options));
}

/** Refetches everything the `knowledge` feature read, after a change to the user's Knowledge. */
export function useRefreshKnowledge() {
  const knowledge = useKnowledge();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: knowledge.key() });
}
