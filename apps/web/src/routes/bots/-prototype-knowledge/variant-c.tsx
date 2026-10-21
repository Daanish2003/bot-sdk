// PROTOTYPE (#734) variant C, "Drop into the thread": the user attaches a file in the message box
// and picks "Add to Knowledge"; an in-thread card walks through the states, then settles into a
// quiet chip. A Bot's save shows the same chip. A small header button opens a minimal list.
import { useState } from "react";

import { Frame, StatusLine, Thread, UsageMeter, fileIcon, sizeText } from "./frame";
import { type KFile, ROOT, type Status, type Stub, baseName, isConverted, usageText } from "./stub";

export const name = "Drop into the thread";

const order: Status[] = ["uploading", "converting", "waking", "ready"];
const label: Record<Status, string> = {
  uploading: "Uploading",
  converting: "Converting",
  waking: "Waking your Computer",
  ready: "Added",
  refused: "Refused",
};

function Chip({ text, file, stub }: { text: string; file?: KFile; stub: Stub }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="self-start text-xs text-muted-foreground">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
        onClick={() => setOpen(!open)}
      >
        📚 {text}
      </button>
      {open && (
        <div className="mt-1 w-[26rem] rounded-lg border p-2 text-foreground">
          {file ? (
            <>
              <div className="font-mono text-[11px]">
                {ROOT}
                {file.path}
              </div>
              {file.copy && (
                <div className="font-mono text-[11px] text-muted-foreground">
                  + {baseName(file.path)}.md (what your Bots read)
                </div>
              )}
              <div className="mt-1 flex items-center text-[11px] text-muted-foreground">
                {sizeText(file)} · shared by all your Bots
                <button
                  type="button"
                  className="ml-auto rounded-md border px-2 py-0.5 text-foreground"
                  onClick={() => stub.remove(file.path)}
                >
                  Delete
                </button>
              </div>
            </>
          ) : (
            <span className="text-muted-foreground">Deleted from Knowledge.</span>
          )}
        </div>
      )}
    </div>
  );
}

function UploadCard({ path, stub }: { path: string; stub: Stub }) {
  const file =
    stub.files.find((f) => f.path === path && f.status !== "ready") ??
    stub.files.find((f) => f.path === path);
  if (file?.status === "ready")
    return <Chip text={`Added to Knowledge: ${baseName(path)}`} file={file} stub={stub} />;
  if (!file)
    return <div className="self-start text-xs text-muted-foreground">📚 {path}: removed</div>;
  const steps = order.filter((s) => s !== "converting" || isConverted(path));
  const at = steps.indexOf(file.status);
  return (
    <div
      className={`max-w-md self-start rounded-xl border p-3 ${file.status === "refused" ? "border-red-300" : ""}`}
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        {fileIcon(path)} {baseName(path)}
        <span className="ml-auto text-xs font-normal text-muted-foreground">→ Knowledge</span>
      </div>
      {file.status === "refused" ? (
        <StatusLine file={file} />
      ) : (
        <ol className="flex gap-3 text-xs">
          {steps.map((s, i) => (
            <li
              key={s}
              className={
                i < at
                  ? "text-muted-foreground line-through"
                  : i === at
                    ? "font-medium"
                    : "text-muted-foreground/50"
              }
            >
              {i === at && "⟳ "}
              {label[s]}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function VariantC({ stub }: { stub: Stub }) {
  const [menu, setMenu] = useState(false);
  const [list, setList] = useState(false);
  const ready = stub.files.filter((f) => f.status === "ready");

  return (
    <Frame
      header={
        <div className="relative">
          <button
            type="button"
            className="rounded-md border px-2 py-1 text-xs"
            onClick={() => setList(!list)}
          >
            📚 {ready.length}
          </button>
          {list && (
            <div className="absolute right-0 top-9 z-20 w-80 rounded-lg border bg-background p-2 shadow-lg">
              <div className="px-1 pb-1 text-[11px] text-muted-foreground">
                Knowledge · shared by all your Bots
              </div>
              <ul className="max-h-80 overflow-auto text-xs">
                {ready.map((f) => (
                  <li key={f.path} className="flex items-center gap-2 px-1 py-0.5">
                    <span className="truncate">{f.path}</span>
                    {f.savedBy !== "you" && (
                      <span className="text-[10px] text-violet-700">{f.savedBy}</span>
                    )}
                    <button
                      type="button"
                      className="ml-auto text-muted-foreground"
                      onClick={() => stub.remove(f.path)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 px-1">
                <UsageMeter files={stub.files} wide />
              </div>
            </div>
          )}
        </div>
      }
      composer={
        <div className="relative flex items-center gap-2 rounded-xl border px-2 py-1.5">
          <button
            type="button"
            className="rounded-md px-1 text-lg"
            title="Attach a file"
            onClick={() => setMenu(!menu)}
          >
            📎
          </button>
          <span className="text-sm text-muted-foreground">Message Planner, or drop a file…</span>
          {menu && (
            <div className="absolute bottom-12 left-0 z-20 w-72 rounded-lg border bg-background p-1 text-sm shadow-lg">
              <button
                type="button"
                className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => setMenu(false)}
              >
                Attach to this message
                <div className="text-[11px] text-muted-foreground">Planner sees it this once</div>
              </button>
              <button
                type="button"
                className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  setMenu(false);
                  stub.upload(true);
                }}
              >
                📚 Add to Knowledge
                <div className="text-[11px] text-muted-foreground">
                  Kept for all your Bots · {usageText(stub.files)} used
                </div>
              </button>
            </div>
          )}
        </div>
      }
    >
      <Thread
        items={stub.items}
        upload={(path) => <UploadCard path={path} stub={stub} />}
        saved={(path, by) => (
          <Chip
            text={`${by} saved to Knowledge: ${path}`}
            file={stub.files.find((f) => f.path === path && f.status === "ready")}
            stub={stub}
          />
        )}
      />
      {stub.ask && (
        <div className="max-w-md self-start rounded-xl border border-amber-400 p-3 text-sm">
          <div className="font-medium">Replace “{stub.ask.path}”?</div>
          <p className="my-1 text-xs text-muted-foreground">
            Knowledge already has this name. Replacing overwrites it and its readable copy for all
            your Bots.
          </p>
          <div className="flex justify-end gap-2 text-xs">
            <button
              type="button"
              className="rounded-md border px-2 py-1"
              onClick={stub.cancelReplace}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-md bg-primary px-2 py-1 text-primary-foreground"
              onClick={() => stub.confirmReplace(true)}
            >
              Replace
            </button>
          </div>
        </div>
      )}
    </Frame>
  );
}
