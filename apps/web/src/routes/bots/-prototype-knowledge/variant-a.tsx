// PROTOTYPE (#734) variant A, "Header popover": a "Knowledge N" button beside Memory and Skills
// opens a popover with a folder tree, a drop zone, per-row status and the usage meter. The `.md`
// copy is hidden; a converted file shows a small "readable copy" tag instead.
import { useState } from "react";

import {
  DropZone,
  Frame,
  ReplaceDialog,
  StatusLine,
  Thread,
  UsageMeter,
  fileIcon,
  sizeText,
} from "./frame";
import { type KFile, ROOT, type Stub, baseName, folderOf } from "./stub";

export const name = "Header popover";

export function VariantA({ stub }: { stub: Stub }) {
  const [open, setOpen] = useState(true);
  const [closed, setClosed] = useState<string[]>([]);
  const ready = stub.files.filter((f) => f.status === "ready");
  const inFlight = stub.files.filter((f) => f.status !== "ready");
  const groups = ["", ...stub.folders];

  const row = (f: KFile) => (
    <li key={`${f.path}:${f.status}`} className="group rounded-md px-2 py-1 hover:bg-muted">
      <div className="flex items-center gap-2 text-sm">
        <span>{fileIcon(f.path)}</span>
        <span className="truncate">{baseName(f.path)}</span>
        {f.copy && (
          <span
            className="rounded bg-muted px-1 text-[10px] text-muted-foreground"
            title={`${baseName(f.path)}.md beside it, which your Bots read`}
          >
            readable copy
          </span>
        )}
        {f.savedBy !== "you" && (
          <span className="rounded bg-violet-100 px-1 text-[10px] text-violet-900">
            saved by {f.savedBy}
          </span>
        )}
        <span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
          {f.status === "ready" ? sizeText(f) : ""}
        </span>
        {f.status === "ready" && (
          <button
            type="button"
            className="invisible text-xs text-muted-foreground group-hover:visible"
            title="Delete (and its readable copy)"
            onClick={() => stub.remove(f.path)}
          >
            ✕
          </button>
        )}
      </div>
      <div className="pl-6">
        <StatusLine file={f} onDismiss={() => stub.dismiss(f.path)} />
      </div>
    </li>
  );

  return (
    <Frame
      header={
        <div className="relative">
          <button
            type="button"
            className="rounded-md border px-2 py-1 text-xs"
            onClick={() => setOpen(!open)}
          >
            Knowledge {ready.length}
            {inFlight.some((f) => f.status !== "refused") && " ·  ⟳"}
          </button>
          {open && (
            <div className="absolute right-0 top-9 z-20 flex w-[28rem] flex-col gap-2 rounded-lg border bg-background p-3 shadow-lg">
              <div className="text-xs text-muted-foreground">
                Shared by all your Bots. They read it when a question needs it, and can save files
                here too.
                <div className="font-mono text-[10px]">{ROOT}</div>
              </div>
              {inFlight.length > 0 && <ul className="flex flex-col gap-1">{inFlight.map(row)}</ul>}
              <ul className="flex max-h-[22rem] flex-col overflow-auto">
                {groups.map((folder) => {
                  const inside = ready.filter((f) => folderOf(f.path) === folder);
                  if (folder === "") return inside.map(row);
                  const isClosed = closed.includes(folder);
                  return (
                    <li key={folder}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-2 py-1 text-sm"
                        onClick={() =>
                          setClosed(
                            isClosed ? closed.filter((c) => c !== folder) : [...closed, folder],
                          )
                        }
                      >
                        {isClosed ? "▸" : "▾"} 📁 {folder}
                        <span className="text-[11px] text-muted-foreground">{inside.length}</span>
                      </button>
                      {!isClosed && <ul className="pl-4">{inside.map(row)}</ul>}
                    </li>
                  );
                })}
              </ul>
              <DropZone stub={stub} compact />
              <UsageMeter files={stub.files} wide />
            </div>
          )}
        </div>
      }
      overlay={
        stub.ask && (
          <ReplaceDialog
            ask={stub.ask}
            onReplace={() => stub.confirmReplace()}
            onCancel={stub.cancelReplace}
          />
        )
      }
    >
      <Thread items={stub.items} />
    </Frame>
  );
}
