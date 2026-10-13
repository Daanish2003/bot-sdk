import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";

import { modelLabel } from "../../core/client/models";
import { useI18n, useOrpc } from "../../core/client/react/provider";
import { serverErrorText } from "../../core/client/rpc-error";
import { parseModelId } from "../../core/shared/chat/models";
import { providerLabel } from "../../core/shared/credentials/services";
import {
  knowledgeAcceptAttribute,
  knowledgeFileExtensions,
  maxKnowledgeFileBytes,
  type KnowledgeFailureCode,
  type KnowledgeMediaType,
} from "../../core/shared/knowledge/kinds";

const megabyte = 1024 * 1024;

/** The dictionary key of each format's name in the Files table. */
const knowledgeTypeKey = {
  "text/markdown": "knowledge.typeMarkdown",
  "text/plain": "knowledge.typeText",
  "text/html": "knowledge.typeHtml",
  "text/csv": "knowledge.typeCsv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "knowledge.typeWord",
  "application/pdf": "knowledge.typePdf",
} as const satisfies Record<KnowledgeMediaType, `knowledge.type${string}`>;

/** Polls the Project's Knowledge every two seconds while a file is still processing. */
const pollWhileProcessing = (query: { state: { data?: { files: { status: string }[] } } }) =>
  query.state.data?.files.some((file) => file.status === "processing") ? 2000 : false;

/**
 * The Project's Knowledge query, shared by the Knowledge tab and the tab's file count. Its
 * `refetchInterval` keeps a processing file's status current without a reload.
 */
export function useProjectKnowledge(projectId: string) {
  const orpc = useOrpc();
  return useQuery(
    orpc.knowledge.list.queryOptions({
      input: { projectId },
      refetchInterval: pollWhileProcessing,
    }),
  );
}

/**
 * The Knowledge tab (spec #357, variant A): the embedding Model picker, the upload button, the
 * files table and its empty state. Files are read in the background; the table polls until each
 * one is Ready or Failed.
 */
export function KnowledgeTab({ projectId }: { projectId: string }) {
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t, locale } = i18n;
  const queryClient = useQueryClient();
  const knowledge = useProjectKnowledge(projectId);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useMutation(orpc.knowledge.upload.mutationOptions());
  const refreshFiles = () => queryClient.invalidateQueries({ queryKey: orpc.knowledge.key() });
  const retry = useMutation(
    orpc.knowledge.retry.mutationOptions({
      onSuccess: refreshFiles,
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const remove = useMutation(
    orpc.knowledge.delete.mutationOptions({
      onSuccess: refreshFiles,
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const setModel = useMutation(
    orpc.knowledge.setModel.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.knowledge.key() }),
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  const data = knowledge.data;
  const stored = data?.embeddingModel ?? null;
  const current = data?.currentModel ?? null;
  const locked = (data?.files.length ?? 0) > 0;
  const pickerItems = [
    ...(data?.models ?? []),
    // A stored Model the user can no longer use stays shown, so the picker names it.
    ...(stored && !data?.models.includes(stored) ? [stored] : []),
  ].map((id) => ({ value: id, label: modelLabel(id) }));

  const uploadFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const added = await upload.mutateAsync({ projectId, file });
        toast.success(t("knowledge.uploadStarted", { name: added.name }));
      } catch (error) {
        toast.error(serverErrorText(i18n, error));
      }
    }
    await queryClient.invalidateQueries({ queryKey: orpc.knowledge.key() });
  };

  return (
    <section className="flex flex-col gap-4" aria-label={t("knowledge.tabKnowledge")}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-medium">{t("knowledge.model")}</p>
          {locked ? (
            <p className="flex items-center gap-1.5 text-sm">
              <Lock className="size-3.5 text-muted-foreground" aria-hidden />
              {current
                ? t("knowledge.lockedModel", {
                    model: modelLabel(current.id),
                    source: current.onHostCredentials
                      ? t("knowledge.sourceHost")
                      : t("knowledge.sourceOwn"),
                  })
                : modelLabel(stored ?? "")}
            </p>
          ) : (
            <Select
              items={pickerItems}
              value={stored ?? current?.id ?? null}
              onValueChange={(value) => value && setModel.mutate({ projectId, model: value })}
              disabled={!data || pickerItems.length === 0 || setModel.isPending}
            >
              <SelectTrigger
                size="sm"
                className="w-64 max-w-full"
                aria-label={t("knowledge.model")}
              >
                <SelectValue placeholder={t("knowledge.noModel")} />
              </SelectTrigger>
              <SelectContent>
                {pickerItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-xs text-muted-foreground">{t("knowledge.modelHelp")}</p>
        </div>
        <div className="shrink-0">
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={knowledgeAcceptAttribute}
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void uploadFiles(files);
            }}
          />
          <Button
            size="sm"
            disabled={!current || upload.isPending}
            onClick={() => inputRef.current?.click()}
          >
            {upload.isPending ? t("knowledge.uploading") : t("knowledge.upload")}
          </Button>
        </div>
      </div>

      {/* Files already added stay Ready; search needs the Model's key back (spec #357). */}
      {data && locked && !current && stored && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
        >
          {t("knowledge.keyMissing", {
            provider: providerLabel(parseModelId(stored)?.provider ?? ""),
          })}
        </p>
      )}
      {data && !locked && !current && (
        <p role="status" className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
          {t("knowledge.addKey")}
        </p>
      )}

      {data && data.files.length === 0 && (
        <div className="rounded-md border border-dashed px-4 py-8 text-center">
          <p className="text-sm font-medium">{t("knowledge.emptyTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("knowledge.emptyHelp", {
              size: maxKnowledgeFileBytes / megabyte,
              types: knowledgeFileExtensions.join(", "),
            })}
          </p>
        </div>
      )}

      {data && data.files.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("knowledge.name")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("knowledge.details")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("knowledge.status")}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t("knowledge.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.files.map((file) => (
                <tr key={file.id} className="border-t align-top">
                  <td className="max-w-56 truncate px-3 py-2 font-medium">{file.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    <p>
                      {t(knowledgeTypeKey[file.mediaType])}
                      {" · "}
                      {formatSize(file.size, locale)}
                      {" · "}
                      {file.chunkCount === null
                        ? "—"
                        : t("knowledge.passages", { count: file.chunkCount })}
                    </p>
                    <p className="text-xs">
                      {t("knowledge.addedOn", { date: formatDate(file.createdAt, locale) })}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={file.status} />
                    {file.status === "failed" && file.failureCode && (
                      <p className="mt-1 text-xs text-destructive">
                        {t(`knowledge.failure.${file.failureCode satisfies KnowledgeFailureCode}`)}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      {file.status === "failed" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={retry.isPending}
                          onClick={() => retry.mutate({ projectId, fileId: file.id })}
                        >
                          {t("knowledge.retry")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(t("knowledge.deleteConfirm", { name: file.name }))) {
                            remove.mutate({ projectId, fileId: file.id });
                          }
                        }}
                      >
                        {t("knowledge.delete")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: "processing" | "ready" | "failed" }) {
  const { t } = useI18n();
  const tone =
    status === "ready"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : status === "failed"
        ? "bg-destructive/15 text-destructive"
        : "bg-muted text-muted-foreground";
  const label =
    status === "ready"
      ? t("knowledge.ready")
      : status === "failed"
        ? t("knowledge.failed")
        : t("knowledge.processing");
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${tone}`}>{label}</span>;
}

/** A size in the locale's units: kilobytes below a megabyte, megabytes after. */
function formatSize(bytes: number, locale: string) {
  return bytes < megabyte
    ? new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "kilobyte",
        maximumFractionDigits: 1,
      }).format(bytes / 1024)
    : new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "megabyte",
        maximumFractionDigits: 1,
      }).format(bytes / megabyte);
}

function formatDate(value: Date | string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));
}
