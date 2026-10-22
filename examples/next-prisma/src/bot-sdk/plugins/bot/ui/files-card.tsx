import { DownloadIcon, FileIcon } from "lucide-react";

import { useChatAdapter, useI18n } from "../../../core/client/react/provider";
import type { FilesControl } from "../shared/files";

/** A size as the card shows it: bytes, KB or MB. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The files a Bot sent (spec #761), a download card under its Message: one row per file with its
 * name and size, each a link that downloads it.
 */
export function FilesCard({ card }: { card: FilesControl }) {
  const { t } = useI18n();
  const { botFilesUrl } = useChatAdapter();
  return (
    <ul
      data-files-card
      aria-label={t("bots.filesLabel")}
      className="flex max-w-[70%] flex-col gap-1 self-start rounded-xl border bg-card p-2 text-sm"
    >
      {card.files.map((file) => (
        <li key={file.id}>
          <a
            data-file={file.id}
            href={`${botFilesUrl}/${file.id}`}
            download={file.name}
            className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted"
          >
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="text-xs text-muted-foreground">{sizeText(file.size)}</span>
            <DownloadIcon className="size-4 shrink-0" aria-label={t("bots.fileDownload")} />
          </a>
        </li>
      ))}
    </ul>
  );
}
