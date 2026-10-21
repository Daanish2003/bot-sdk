// PROTOTYPE (#734) variant B, "Its own page": Knowledge is shared by all Bots, so it gets its own
// page from the Bots sidebar (rendered here in place of the chat). Folder tree on the left, a
// preview on the right with the original's details and the readable `.md` text the Bots read.
import { useState } from "react";

import { Frame, ReplaceDialog, StatusLine, Thread, UsageMeter, fileIcon } from "./frame";
import { type KFile, ROOT, type Stub, baseName, folderOf, mb } from "./stub";

export const name = "Its own page";

export function VariantB({ stub }: { stub: Stub }) {
  const [page, setPage] = useState<"knowledge" | "chat">("knowledge");
  const [selected, setSelected] = useState("Employee handbook.pdf");
  const [showCopies, setShowCopies] = useState(false);
  const [folder, setFolder] = useState("");
  const ready = stub.files.filter((f) => f.status === "ready");
  const inFlight = stub.files.filter((f) => f.status !== "ready");
  const current = ready.find((f) => f.path === selected);

  const sidebar = (
    <nav className="flex w-48 shrink-0 flex-col gap-1 border-r p-2 text-sm">
      <div className="px-2 pb-1 text-[11px] uppercase text-muted-foreground">Bots</div>
      {["Planner", "Researcher"].map((bot) => (
        <button
          key={bot}
          type="button"
          onClick={() => setPage("chat")}
          className={`rounded-md px-2 py-1 text-left ${page === "chat" && bot === "Planner" ? "bg-muted font-medium" : ""}`}
        >
          🤖 {bot}
        </button>
      ))}
      <div className="my-2 border-t" />
      <button
        type="button"
        onClick={() => setPage("knowledge")}
        className={`rounded-md px-2 py-1 text-left ${page === "knowledge" ? "bg-muted font-medium" : ""}`}
      >
        📚 Knowledge <span className="text-xs text-muted-foreground">{ready.length}</span>
      </button>
      <div className="px-2 text-[11px] text-muted-foreground">Shared by all your Bots</div>
    </nav>
  );

  const treeRow = (f: KFile, depth: number) => (
    <div key={`${f.path}:${f.status}`}>
      <button
        type="button"
        onClick={() => f.status === "ready" && setSelected(f.path)}
        style={{ paddingLeft: 8 + depth * 14 }}
        className={`flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-sm ${selected === f.path && f.status === "ready" ? "bg-muted" : "hover:bg-muted/60"}`}
      >
        {fileIcon(f.path)} <span className="truncate">{baseName(f.path)}</span>
        {f.savedBy !== "you" && (
          <span className="ml-auto text-[10px] text-violet-700">{f.savedBy}</span>
        )}
      </button>
      {showCopies && f.copy && f.status === "ready" && (
        <div
          style={{ paddingLeft: 22 + depth * 14 }}
          className="py-0.5 text-xs text-muted-foreground"
        >
          ↳ {baseName(f.path)}.md
        </div>
      )}
      {f.status !== "ready" && (
        <div style={{ paddingLeft: 22 + depth * 14 }} className="pr-2">
          <StatusLine file={f} onDismiss={() => stub.dismiss(f.path)} />
        </div>
      )}
    </div>
  );

  const tree = (
    <div className="flex w-80 shrink-0 flex-col border-r">
      <div className="flex items-center gap-2 border-b p-2">
        <button
          type="button"
          className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
          onClick={() => stub.upload()}
        >
          Upload{folder ? ` to ${folder}/` : ""}
        </button>
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-xs"
          onClick={() => stub.newFolder(`folder-${stub.folders.length + 1}`)}
        >
          New folder
        </button>
        <label className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={showCopies}
            onChange={(e) => setShowCopies(e.target.checked)}
          />
          .md copies
        </label>
      </div>
      <div className="flex-1 overflow-auto p-1">
        {inFlight.map((f) => treeRow(f, 0))}
        {ready.filter((f) => folderOf(f.path) === "").map((f) => treeRow(f, 0))}
        {stub.folders.map((dir) => (
          <div key={dir}>
            <button
              type="button"
              onClick={() => setFolder(folder === dir ? "" : dir)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${folder === dir ? "ring-1 ring-primary" : ""}`}
            >
              📁 {dir}
            </button>
            {ready.filter((f) => folderOf(f.path) === dir).map((f) => treeRow(f, 1))}
          </div>
        ))}
      </div>
      <div className="border-t p-2">
        <UsageMeter files={stub.files} wide />
      </div>
    </div>
  );

  const preview = current ? (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-start gap-3 border-b p-4">
        <span className="text-3xl">{fileIcon(current.path)}</span>
        <div className="min-w-0">
          <div className="font-medium">{baseName(current.path)}</div>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground">
            <dt>Path</dt>
            <dd className="font-mono">
              {ROOT}
              {current.path}
            </dd>
            <dt>Size</dt>
            <dd>{mb(current.sizeKb)}</dd>
            <dt>Added</dt>
            <dd>
              {current.addedAt} by{" "}
              {current.savedBy === "you" ? "you" : `${current.savedBy} (a Bot)`}
            </dd>
            {current.copy && (
              <>
                <dt>Bots read</dt>
                <dd className="font-mono">
                  {baseName(current.path)}.md · {mb(current.copy.sizeKb)}
                </dd>
              </>
            )}
          </dl>
        </div>
        <div className="ml-auto flex gap-2 text-xs">
          <button type="button" className="rounded-md border px-2 py-1">
            Download original
          </button>
          <button
            type="button"
            className="rounded-md border border-red-300 px-2 py-1 text-red-700"
            onClick={() => stub.remove(current.path)}
            title={current.copy ? "Deletes the original and its .md copy" : undefined}
          >
            Delete
          </button>
        </div>
      </div>
      <div className="px-4 pt-3 text-[11px] uppercase text-muted-foreground">
        {current.copy ? "Readable text (what your Bots read)" : "Contents"}
      </div>
      <pre className="m-4 mt-1 flex-1 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs">
        {current.copy?.text ?? current.text}
      </pre>
    </section>
  ) : (
    <section className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      Pick a file to see it.
    </section>
  );

  return (
    <Frame
      main={
        <div className="flex min-h-0 flex-1">
          {sidebar}
          {page === "knowledge" ? (
            <>
              {tree}
              {preview}
            </>
          ) : (
            <main className="flex min-w-0 flex-1 flex-col">
              <div className="flex flex-1 flex-col gap-3 overflow-auto p-4 pb-24">
                <Thread items={stub.items} />
              </div>
              <div className="border-t p-3">
                <div className="rounded-xl border px-3 py-2 text-sm text-muted-foreground">
                  Message Planner…
                </div>
              </div>
            </main>
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
    />
  );
}
