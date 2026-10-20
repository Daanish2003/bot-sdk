// PROTOTYPE (#623) variant B, "The files": a "Memory" header button opens a full-screen file view,
// slide 11 literally: a file tree on the left, the raw plain text on the right, edited as text.
// Other Bots' profile.md files are read-only. The thread shows only a quiet line linking to the file.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FileTextIcon, FolderIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { fileText, filePath, otherBots, type Tier, thisBot, useMemory } from "./mock";
import { Shell, Thread } from "./thread";

export const name = "The files";

type Open = { bot: string; tier: Tier };

function FileView({ onClose, initial }: { onClose: () => void; initial: Open }) {
  const { lines, saveFile } = useMemory();
  const [open, setOpen] = useState<Open>(initial);
  const mine = open.bot === thisBot;
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? fileText(lines, open.bot, open.tier);
  const files: Open[] = [
    { bot: thisBot, tier: "profile" },
    { bot: thisBot, tier: "log" },
    { bot: thisBot, tier: "notes" },
    ...otherBots.map((bot) => ({ bot, tier: "profile" as Tier })),
  ];
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <FolderIcon className="size-4" />
        <span className="font-mono text-sm">/home/user/bots</span>
        <button type="button" className="ml-auto" onClick={onClose}>
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-72 flex-col gap-0.5 border-r p-2 font-mono text-xs">
          {files.map((f) => (
            <button
              key={filePath(f.bot, f.tier)}
              type="button"
              className={cn(
                "flex items-center gap-1 rounded px-2 py-1 text-left",
                f.bot === open.bot && f.tier === open.tier && "bg-muted",
                f.bot !== thisBot && "text-muted-foreground",
              )}
              onClick={() => {
                setOpen(f);
                setDraft(null);
              }}
            >
              <FileTextIcon className="size-3.5" />
              {filePath(f.bot, f.tier)}
            </button>
          ))}
          <p className="mt-auto p-2 font-sans text-[11px] text-muted-foreground">
            Every Bot reads all the profile.md files. Each Bot writes only its own folder.
          </p>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-4 py-1 text-xs text-muted-foreground">
            <span className="font-mono">{filePath(open.bot, open.tier)}</span>
            {!mine && <span>· read-only, {open.bot} writes it</span>}
            {mine && draft !== null && (
              <Button
                size="sm"
                className="ml-auto h-6"
                onClick={() => {
                  saveFile(open.tier, draft);
                  setDraft(null);
                }}
              >
                Save
              </Button>
            )}
          </div>
          <textarea
            className="flex-1 resize-none bg-transparent p-4 font-mono text-sm outline-none"
            readOnly={!mine}
            value={text}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

export function VariantB() {
  const [open, setOpen] = useState<Open | null>(null);
  return (
    <Shell
      header={
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setOpen({ bot: thisBot, tier: "profile" })}
        >
          <FolderIcon className="size-3.5" /> Memory files
        </Button>
      }
    >
      <Thread
        renderChanges={(changes, _i, item) => (
          <button
            type="button"
            className="self-start font-mono text-[11px] text-muted-foreground hover:underline"
            onClick={() => setOpen({ bot: thisBot, tier: changes[0].tier })}
          >
            {item.undone
              ? "memory edit undone"
              : `edited ${[...new Set(changes.map((c) => filePath(thisBot, c.tier).split("/memory/")[1]))].join(", ")}`}
          </button>
        )}
      />
      {open && <FileView initial={open} onClose={() => setOpen(null)} />}
    </Shell>
  );
}
