import { Button } from "@/components/ui/button";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  documentChars,
  maxReleaseDocumentChars,
  type RepresentativeView,
} from "@botsdk/representative/client";
import {
  useKnowledgeChoices,
  useKnowledgeStatus,
  usePickKnowledge,
  useRefreshRepresentatives,
  useRemoveDocument,
  useUploadDocument,
} from "@botsdk/representative/react";

/** Whether the draft's documents keep it from being approved. */
export const documentsOverCap = (representative: RepresentativeView) =>
  documentChars(representative.draft.documents) > maxReleaseDocumentChars;

/**
 * Uploading and removing a draft's documents. The page holds these, as nothing may be approved while
 * the documents are changing, and each counts as pending until the page has the draft it left.
 */
export function useDocumentChanges() {
  const i18n = useI18n();
  const refresh = useRefreshRepresentatives();
  const onError = (error: Parameters<typeof serverErrorText>[1]) =>
    toast.error(serverErrorText(i18n, error));
  const upload = useUploadDocument({ onSuccess: refresh, onError });
  const remove = useRemoveDocument({ onSuccess: refresh, onError });
  const pick = usePickKnowledge({ onSuccess: refresh, onError });
  return {
    upload,
    remove,
    pick,
    pending: upload.isPending || remove.isPending || pick.isPending,
  };
}

/**
 * The draft's documents: uploaded and removed on the spot, apart from Save draft, since their text is
 * copied to the server as they are chosen.
 */
export function DraftDocuments({
  representative,
  changes: { upload, remove, pick },
  busy,
}: {
  representative: RepresentativeView;
  changes: ReturnType<typeof useDocumentChanges>;
  busy: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { id, draft } = representative;
  const input = useRef<HTMLInputElement>(null);
  // The picker is offered only on a Host that passed Knowledge; the Computer wakes only once opened.
  const knowledgeOn = useKnowledgeStatus().data?.available === true;
  const [picking, setPicking] = useState(false);
  const choices = useKnowledgeChoices(picking);
  const chars = documentChars(draft.documents);
  const number = (value: number) => value.toLocaleString(i18n.locale);
  return (
    <section className="space-y-2" aria-label={t("representative.documents")}>
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("representative.documents")}</h3>
        <p className="text-xs text-muted-foreground">{t("representative.documentsHelp")}</p>
      </div>
      {draft.documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("representative.noDocuments")}</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {draft.documents.map((document) => (
            <li
              key={document.id}
              data-document={document.name}
              className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 break-words font-medium">{document.name}</span>
              <span className="text-xs text-muted-foreground">
                {t("representative.documentChars", { chars: number(document.chars) })}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={`${t("representative.removeDocument")} ${document.name}`}
                onClick={() => remove.mutate({ id, documentId: document.id })}
              >
                {t("representative.removeDocument")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {t("representative.documentsTotal", {
          chars: number(chars),
          limit: number(maxReleaseDocumentChars),
        })}
      </p>
      {documentsOverCap(representative) && (
        <p role="alert" className="text-sm text-destructive">
          {t("representative.documentsOverCap", { limit: number(maxReleaseDocumentChars) })}
        </p>
      )}
      <input
        ref={input}
        type="file"
        multiple={false}
        accept=".md,.txt,.pdf,.docx"
        className="sr-only"
        aria-label={t("representative.uploadDocumentFile")}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared, so choosing the same file again uploads it again.
          event.target.value = "";
          if (file) upload.mutate({ id, file });
        }}
      />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>
        {t("representative.uploadDocument")}
      </Button>
      {knowledgeOn && (
        <Button
          variant="outline"
          size="sm"
          className="ml-2"
          disabled={busy}
          onClick={() => setPicking((open) => !open)}
        >
          {picking ? t("representative.pickKnowledgeClose") : t("representative.pickKnowledge")}
        </Button>
      )}
      {knowledgeOn && picking && (
        <div className="space-y-2" data-testid="knowledge-picker">
          <p className="text-xs text-muted-foreground">{t("representative.pickKnowledgeHelp")}</p>
          {choices.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {serverErrorText(i18n, choices.error)}
            </p>
          ) : choices.data === undefined ? (
            <p className="text-sm text-muted-foreground">
              {t("representative.pickKnowledgeLoading")}
            </p>
          ) : choices.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("representative.pickKnowledgeEmpty")}
            </p>
          ) : (
            <ul className="divide-y overflow-hidden rounded-xl border">
              {choices.data.map((file) => (
                <li
                  key={file.path}
                  data-knowledge={file.path}
                  className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 break-words">{file.path}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`${t("representative.pickKnowledgeUse")} ${file.path}`}
                    onClick={() => pick.mutate({ id, path: file.path })}
                  >
                    {t("representative.pickKnowledgeUse")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
