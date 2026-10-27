import { inlineImageTypes, type FilesControl } from "@botsdk/client/bot/files";
import { DownloadIcon, FileIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

import { useChatAdapter, useI18n } from "../../../core/client/react/provider";

/** A size as the card shows it: bytes, KB or MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The files a Bot sent (spec #761), a download card under its Message: one row per file with its
 * name and size, each a link that downloads it. An image also shows as a thumbnail that zooms on
 * click (spec #801).
 */
export function FilesCard({ card, className }: { card: FilesControl; className?: string }) {
  const { t } = useI18n();
  const { botFilesUrl } = useChatAdapter();
  const [zoomed, setZoomed] = useState<FilesControl["files"][number] | null>(null);
  return (
    <ul
      data-files-card
      aria-label={t("bots.filesLabel")}
      className={cn(
        "flex max-w-[70%] flex-col gap-1 self-start rounded-xl border bg-card p-2 text-sm",
        className,
      )}
    >
      {card.files.map((file) => (
        <li key={file.id}>
          {inlineImageTypes.has(file.mediaType) && (
            <button
              type="button"
              data-thumbnail={file.id}
              aria-label={file.name}
              onClick={() => setZoomed(file)}
              className="block rounded-md hover:opacity-90"
            >
              <img
                src={`${botFilesUrl}/${file.id}/inline`}
                alt={file.name}
                loading="lazy"
                className="max-h-40 rounded-md object-contain"
              />
            </button>
          )}
          <a
            data-file={file.id}
            href={`${botFilesUrl}/${file.id}`}
            download={file.name}
            className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted"
          >
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="text-xs text-muted-foreground">{formatSize(file.size)}</span>
            <DownloadIcon className="size-4 shrink-0" aria-label={t("bots.fileDownload")} />
          </a>
        </li>
      ))}
      {card.files.some((file) => inlineImageTypes.has(file.mediaType)) && (
        <Dialog open={zoomed !== null} onOpenChange={(open) => !open && setZoomed(null)}>
          <DialogContent className="max-w-[90vw] sm:max-w-3xl">
            <DialogTitle className="truncate">{zoomed?.name}</DialogTitle>
            {zoomed && (
              <img
                data-zoomed
                src={`${botFilesUrl}/${zoomed.id}/inline`}
                alt={zoomed.name}
                className="max-h-[75vh] w-full object-contain"
              />
            )}
          </DialogContent>
        </Dialog>
      )}
    </ul>
  );
}
