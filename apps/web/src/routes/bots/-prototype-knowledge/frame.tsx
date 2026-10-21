// PROTOTYPE (#734): the bare Bot page and small pieces the variants share. Each variant decides
// where Knowledge lives (header popover, its own page, or the thread).
import type { ReactNode } from "react";

import {
  type Ask,
  CAP_KB,
  type Item,
  type KFile,
  type Stub,
  mb,
  statusText,
  totalKb,
  usageText,
} from "./stub";

export function Frame({
  header,
  children,
  composer,
  main,
  overlay,
}: {
  header?: ReactNode;
  children?: ReactNode;
  /** Replaces the plain message box. */
  composer?: ReactNode;
  /** Replaces the whole chat column (variant B's Knowledge page). */
  main?: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div className="relative flex h-dvh flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <span className="font-semibold">Planner</span>
        <span className="text-xs text-muted-foreground">Bot · claude-sonnet-5-5</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="rounded-md border px-2 py-1 text-xs">
            Memory
          </button>
          <button type="button" className="rounded-md border px-2 py-1 text-xs">
            Skills 4
          </button>
          {header}
        </div>
      </header>
      {main ?? (
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex flex-1 flex-col gap-3 overflow-auto p-4 pb-24">{children}</div>
          <div className="border-t p-3">
            {composer ?? (
              <div className="rounded-xl border px-3 py-2 text-sm text-muted-foreground">
                Message Planner…
              </div>
            )}
          </div>
        </main>
      )}
      {overlay}
    </div>
  );
}

/** The stub thread. Bot replies are plain SendToUser text; citations are plain text, no chips. */
export function Thread({
  items,
  upload,
  saved,
}: {
  items: Item[];
  upload?: (path: string) => ReactNode;
  saved?: (path: string, by: string) => ReactNode;
}) {
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === "user")
          return (
            <div
              key={i}
              className="flex max-w-[70%] flex-col gap-1 self-end rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground"
            >
              {item.attachment && (
                <span className="rounded-md bg-white/15 px-2 py-1 text-xs">
                  📎 {item.attachment}
                </span>
              )}
              {item.text}
            </div>
          );
        if (item.kind === "bot")
          return (
            <div key={i} className="max-w-[70%] self-start rounded-2xl bg-muted px-3 py-2 text-sm">
              {item.text}
            </div>
          );
        if (item.kind === "upload") return upload ? <div key={i}>{upload(item.path)}</div> : null;
        return saved ? <div key={i}>{saved(item.path, item.by)}</div> : null;
      })}
    </>
  );
}

export function UsageMeter({ files, wide }: { files: KFile[]; wide?: boolean }) {
  const pct = Math.min(100, (totalKb(files) / CAP_KB) * 100);
  return (
    <div
      className={`flex items-center gap-2 text-xs text-muted-foreground ${wide ? "w-full" : ""}`}
    >
      <div className={`h-1.5 overflow-hidden rounded-full bg-muted ${wide ? "flex-1" : "w-24"}`}>
        <div
          className={`h-full ${pct > 80 ? "bg-amber-500" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="whitespace-nowrap">{usageText(files)}</span>
    </div>
  );
}

export function StatusLine({ file, onDismiss }: { file: KFile; onDismiss?: () => void }) {
  if (file.status === "ready") return null;
  if (file.status === "refused")
    return (
      <div className="flex items-start gap-2 text-xs text-red-600">
        <span>✕ {file.reason}. Nothing was added.</span>
        {onDismiss && (
          <button type="button" className="ml-auto underline" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    );
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="size-2 animate-pulse rounded-full bg-primary" />
      {statusText[file.status]}
    </div>
  );
}

export function fileIcon(path: string) {
  if (/\.pdf$/i.test(path)) return "📕";
  if (/\.docx$/i.test(path)) return "📘";
  if (/\.csv$/i.test(path)) return "📊";
  if (/\.html$/i.test(path)) return "🌐";
  return "📄";
}

export function sizeText(file: KFile) {
  return file.copy ? `${mb(file.sizeKb)} + ${mb(file.copy.sizeKb)} text` : mb(file.sizeKb);
}

export function ReplaceDialog({
  ask,
  onReplace,
  onCancel,
}: {
  ask: Ask;
  onReplace: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="w-96 rounded-lg border bg-background p-4 shadow-lg">
        <div className="mb-1 font-medium">Replace “{ask.path}”?</div>
        <p className="mb-3 text-sm text-muted-foreground">
          Knowledge already has a file with this name in this folder. Replacing it overwrites the
          file and its readable copy for all your Bots.
        </p>
        <div className="flex justify-end gap-2 text-sm">
          <button type="button" className="rounded-md border px-3 py-1" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1 text-primary-foreground"
            onClick={onReplace}
          >
            Replace
          </button>
        </div>
      </div>
    </div>
  );
}

/** Fake drop zone: clicking it runs the stub upload. */
export function DropZone({ stub, compact }: { stub: Stub; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => stub.upload()}
      className={`w-full rounded-lg border-2 border-dashed text-center text-xs text-muted-foreground hover:bg-muted ${compact ? "p-2" : "p-4"}`}
    >
      Drop files here or click to upload
      <div className="text-[10px]">.md .txt .html .csv .docx .pdf · up to 20 MB</div>
    </button>
  );
}
