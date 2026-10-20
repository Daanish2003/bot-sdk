// PROTOTYPE (#623) variant C, "What the Bot knows": a side panel always beside the thread, split by
// what is in the Bot's prompt now versus what only search finds, with Log scores and Notes fading,
// plus a search box. Each Turn's pass shows as an inline diff card with Undo.
import { cn } from "@/lib/utils";
import { BrainIcon, PanelRightIcon, SearchIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { ageDays, inPrompt, type Line, score, thisBot, tierLabel, useMemory } from "./mock";
import { Shell, Thread } from "./thread";

export const name = "What the Bot knows";

function Fact({ line, live }: { line: Line; live: boolean }) {
  const { remove } = useMemory();
  const mine = line.bot === thisBot;
  return (
    <li
      className={cn(
        "group flex items-start gap-2 rounded px-1 py-1 text-sm",
        !live && "text-muted-foreground",
      )}
    >
      <span className="w-14 shrink-0 text-[10px] text-muted-foreground uppercase">
        {tierLabel[line.tier]}
      </span>
      <span className="flex-1">
        {line.text}
        {!mine && <span className="text-[11px]"> · {line.bot}</span>}
        {line.tier === "log" && (
          <span className="mt-0.5 flex items-center gap-1 text-[10px]">
            <span className="h-1 rounded bg-sky-500" style={{ width: `${score(line) * 60}px` }} />
            {line.date} · importance {line.importance}
          </span>
        )}
        {line.tier === "notes" && (
          <span className="block text-[10px]">
            {live
              ? `fades in ${2 - ageDays(line.date!) + 1} day(s)`
              : `faded ${ageDays(line.date!) - 2} day(s) ago`}
          </span>
        )}
      </span>
      {mine && (
        <button
          type="button"
          className="opacity-0 group-hover:opacity-100"
          onClick={() => remove(line.id)}
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </li>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const { lines } = useMemory();
  const [q, setQ] = useState("");
  const live = inPrompt(lines);
  const visible = lines.filter((l) => l.tier === "profile" || l.bot === thisBot);
  const hits = q
    ? visible
        .filter((l) => l.text.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => score(b) - score(a))
    : null;
  return (
    <aside className="flex w-96 flex-col gap-3 overflow-auto border-l p-3">
      <div className="flex items-center gap-2">
        <BrainIcon className="size-4" />
        <span className="font-medium">What {thisBot} knows</span>
        <button type="button" className="ml-auto" onClick={onClose}>
          <XIcon className="size-4" />
        </button>
      </div>
      <label className="flex items-center gap-1 rounded-md border px-2 py-1">
        <SearchIcon className="size-3.5" />
        <input
          className="flex-1 bg-transparent text-sm outline-none"
          placeholder="Search memory"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      {hits ? (
        <ul>
          {hits.map((l) => (
            <Fact key={l.id} line={l} live={live.has(l.id)} />
          ))}
        </ul>
      ) : (
        <>
          <h3 className="text-xs font-medium text-muted-foreground uppercase">In its prompt now</h3>
          <ul>
            {visible
              .filter((l) => live.has(l.id))
              .map((l) => (
                <Fact key={l.id} line={l} live />
              ))}
          </ul>
          <h3 className="text-xs font-medium text-muted-foreground uppercase">
            Found only by search
          </h3>
          <ul>
            {visible
              .filter((l) => !live.has(l.id))
              .map((l) => (
                <Fact key={l.id} line={l} live={false} />
              ))}
          </ul>
        </>
      )}
    </aside>
  );
}

export function VariantC() {
  const { undo } = useMemory();
  const [open, setOpen] = useState(true);
  return (
    <Shell
      header={
        <button type="button" className="rounded-md border p-1" onClick={() => setOpen(!open)}>
          <PanelRightIcon className="size-4" />
        </button>
      }
      side={open && <Panel onClose={() => setOpen(false)} />}
    >
      <Thread
        renderChanges={(changes, i, item) =>
          item.undone ? (
            <span className="text-xs text-muted-foreground">Memory change undone</span>
          ) : (
            <div className="flex flex-col gap-0.5 rounded-xl border p-2 text-xs">
              {changes.map((c, k) => (
                <div key={k}>
                  <span
                    className={cn(
                      "mr-1 font-medium",
                      c.kind === "remove" ? "text-red-600" : "text-emerald-600",
                    )}
                  >
                    {c.kind === "add" ? "Remembered" : c.kind === "remove" ? "Forgot" : "Changed"}
                  </span>
                  {c.was && <s className="mr-1 text-muted-foreground">{c.was}</s>}
                  <span className={cn(c.kind === "remove" && "line-through")}>{c.text}</span>
                  <span className="text-muted-foreground"> · {tierLabel[c.tier]}</span>
                </div>
              ))}
              <button type="button" className="self-end underline" onClick={() => undo(i)}>
                Undo
              </button>
            </div>
          )
        }
      />
    </Shell>
  );
}
