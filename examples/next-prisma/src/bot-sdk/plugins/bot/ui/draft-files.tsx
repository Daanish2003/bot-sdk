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
import { FileIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useRef } from "react";

import { useI18n } from "../../../core/client/react/provider";
import type { BotUploads } from "../client/react/uploads";
import { formatSize } from "./files-card";

/** The paperclip: picks the files to send the Bot (spec #801). */
export function AttachButton({ uploads, disabled }: { uploads: BotUploads; disabled?: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-attach-input
        onChange={(event) => {
          uploads.add(event.target.files ?? []);
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        onClick={() => input.current?.click()}
        title={t("bots.attachFiles")}
        aria-label={t("bots.attachFiles")}
      >
        <PaperclipIcon />
      </Button>
    </>
  );
}

/** The draft's files above the textarea, each with its upload progress or error and a remove button. */
export function DraftFileChips({ uploads }: { uploads: BotUploads }) {
  const { t } = useI18n();
  if (uploads.items.length === 0) return null;
  return (
    <AttachmentGroup data-draft-files className="px-3 pt-2">
      {uploads.items.map((item) => (
        <Attachment key={item.key} size="sm" state={item.state} className="min-w-0">
          <AttachmentMedia>
            <FileIcon />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle title={item.name}>{item.name}</AttachmentTitle>
            <AttachmentDescription>
              {item.state === "error" ? item.error : formatSize(item.size)}
            </AttachmentDescription>
          </AttachmentContent>
          <AttachmentAction
            onClick={() => uploads.remove(item.key)}
            aria-label={t("bots.removeFile", { name: item.name })}
          >
            <XIcon />
          </AttachmentAction>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}
