import { Button } from "@/components/ui/button";
import { useRef } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  documentChars,
  maxReleaseDocumentChars,
  type RepresentativeView,
} from "@botsdk/representative/client";
import {
  useRefreshRepresentatives,
  useRemoveDocument,
  useUploadDocument,
} from "@botsdk/representative/react";

/** Whether the draft's documents keep it from being approved. */
export const documentsOverCap = (representative: RepresentativeView) =>
  documentChars(representative.draft.documents) > maxReleaseDocumentChars;

/**
 * The draft's documents: uploaded and removed on the spot, apart from Save draft, since their text is
 * copied to the server as they are chosen.
 */
export function DraftDocuments({ representative }: { representative: RepresentativeView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { id, draft } = representative;
  const input = useRef<HTMLInputElement>(null);
  const refresh = useRefreshRepresentatives();
  const onError = (error: Parameters<typeof serverErrorText>[1]) =>
    toast.error(serverErrorText(i18n, error));
  const upload = useUploadDocument({ onSuccess: refresh, onError });
  const remove = useRemoveDocument({ onSuccess: refresh, onError });
  const busy = upload.isPending || remove.isPending;
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
    </section>
  );
}
