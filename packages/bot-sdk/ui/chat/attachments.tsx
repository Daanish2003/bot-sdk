import {
  acceptAttribute,
  acceptedKinds,
  attachmentKind,
  maxAttachmentBytes,
} from "../../core/shared/attachments/kinds";
import type { AttachmentInfo } from "../../core/shared/attachments/kinds";
import { findModel } from "../../core/shared/chat/models";
import type { AttachmentChip } from "../../plugins/assistant/client/chat";
import {
  Attachment,
  AttachmentAction,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileTextIcon, ImageIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import type { Translate } from "../../core/shared/i18n";
import { useI18n, useOrpc } from "../../core/client/react/provider";
import { serverErrorText } from "../../core/client/rpc-error";

/** A file in the composer: uploading, uploaded (with its id), or failed. */
type DraftAttachment = AttachmentChip & {
  key: string;
  state: "uploading" | "done" | "error";
  error?: string;
};

/**
 * The files attached to a Message being written or edited. Each file uploads as soon as it is
 * picked; sending waits until every upload has finished. `initial` are attachments carried over
 * from the Message being edited.
 */
export function useAttachmentDraft(model: string | undefined, initial: AttachmentInfo[] = []) {
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const [items, setItems] = useState<DraftAttachment[]>(() =>
    initial.map((info) => ({ ...info, key: info.id, state: "done" })),
  );
  const upload = useMutation(orpc.attachment.upload.mutationOptions());
  // `models.list` includes the live OpenRouter and Ollama Models, which aren't curated.
  const available = useQuery(orpc.models.list.queryOptions());
  const kinds = acceptedKinds(
    model
      ? (available.data?.models.find((candidate) => candidate.id === model) ?? findModel(model))
      : undefined,
  );
  const update = (key: string, fields: Partial<DraftAttachment>) =>
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...fields } : item)),
    );

  const add = (files: Iterable<File>) => {
    for (const file of files) {
      const kind = attachmentKind(file.type, file.name);
      if (!kind || !kinds.includes(kind)) {
        toast.error(t("chat.cantAttach", { name: file.name }));
        continue;
      }
      if (file.size > maxAttachmentBytes) {
        toast.error(t("chat.tooLarge", { name: file.name }));
        continue;
      }
      const key = crypto.randomUUID();
      setItems((current) => [
        ...current,
        { key, filename: file.name, mediaType: file.type, size: file.size, state: "uploading" },
      ]);
      upload.mutateAsync({ file }).then(
        (info) => update(key, { ...info, state: "done" }),
        (error: Error) => update(key, { state: "error", error: serverErrorText(i18n, error) }),
      );
    }
  };

  const uploaded = items.flatMap(({ id, filename, mediaType, size, state }) =>
    state === "done" && id && size !== undefined ? [{ id, filename, mediaType, size }] : [],
  );
  return {
    items,
    add,
    remove: (key: string) => setItems((current) => current.filter((item) => item.key !== key)),
    clear: () => setItems([]),
    /** The uploaded attachments, in order, for the command. */
    uploaded,
    /** Sending must wait: a file is still uploading, or failed and should be removed. */
    pending: items.some((item) => item.state !== "done"),
    /** The `accept` attribute for the file picker; empty when the Model takes no files. */
    accept: acceptAttribute(kinds),
  };
}

export type AttachmentDraft = ReturnType<typeof useAttachmentDraft>;

/** The paperclip: picks files the Model accepts. Hidden when it accepts none. */
export function AttachButton({ draft, disabled }: { draft: AttachmentDraft; disabled?: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  if (!draft.accept) return null;
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={draft.accept}
        onChange={(event) => {
          draft.add(event.target.files ?? []);
          event.target.value = "";
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full"
        disabled={disabled}
        onClick={() => input.current?.click()}
        title={t("chat.attachFiles")}
        aria-label={t("chat.attachFiles")}
      >
        <PaperclipIcon />
      </Button>
    </>
  );
}

/** The composer's attachments, removable, with upload progress and errors. */
export function DraftAttachmentChips({ draft }: { draft: AttachmentDraft }) {
  if (draft.items.length === 0) return null;
  return (
    <AttachmentGroup className="px-2 pt-1">
      {draft.items.map((item) => (
        <AttachmentChipView
          key={item.key}
          attachment={item}
          state={item.state}
          description={item.state === "error" ? item.error : undefined}
          onRemove={() => draft.remove(item.key)}
        />
      ))}
    </AttachmentGroup>
  );
}

/** A Message's attachments as chips. */
export function AttachmentChips({ attachments }: { attachments: AttachmentChip[] }) {
  if (attachments.length === 0) return null;
  return (
    <AttachmentGroup className="max-w-[80ch]">
      {attachments.map((attachment, index) => (
        <AttachmentChipView key={attachment.id ?? index} attachment={attachment} />
      ))}
    </AttachmentGroup>
  );
}

function AttachmentChipView({
  attachment,
  state = "done",
  description,
  onRemove,
}: {
  attachment: AttachmentChip;
  state?: DraftAttachment["state"];
  description?: string;
  onRemove?: () => void;
}) {
  const { t, locale } = useI18n();
  const kind = attachmentKind(attachment.mediaType, attachment.filename);
  const label =
    kind === "image"
      ? t("chat.kindImage")
      : kind === "pdf"
        ? t("chat.kindPdf")
        : t("chat.kindText");
  return (
    <Attachment size="sm" state={state} className="min-w-0">
      <AttachmentMedia>{kind === "image" ? <ImageIcon /> : <FileTextIcon />}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={attachment.filename}>{attachment.filename}</AttachmentTitle>
        <AttachmentDescription>
          {description ??
            [label, attachment.size !== undefined && formatSize(t, attachment.size, locale)]
              .filter(Boolean)
              .join(" · ")}
        </AttachmentDescription>
      </AttachmentContent>
      {onRemove && (
        <AttachmentAction
          onClick={onRemove}
          aria-label={t("chat.removeFile", { name: attachment.filename })}
        >
          <XIcon />
        </AttachmentAction>
      )}
    </Attachment>
  );
}

/** A file's size in the viewer's locale, in B, KB or MB. */
function formatSize(t: Translate, bytes: number, locale: string) {
  const number = (value: number, maximumFractionDigits: number) =>
    value.toLocaleString(locale, { maximumFractionDigits });
  if (bytes < 1024) return t("chat.sizeBytes", { count: number(bytes, 0) });
  if (bytes < 1024 * 1024)
    return t("chat.sizeKilobytes", { count: number(Math.round(bytes / 1024), 0) });
  return t("chat.sizeMegabytes", { count: number(bytes / (1024 * 1024), 1) });
}
