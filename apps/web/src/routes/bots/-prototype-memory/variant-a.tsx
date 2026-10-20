// PROTOTYPE (#623) variant A, "In the thread": a "Memory" header popover (like Routines and To-do)
// lists the tiers as facts you edit in place; each Turn's pass shows as a small chip under its reply.
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BrainIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { type Change, inPrompt, type Line, type Tier, thisBot, tierLabel, useMemory } from "./mock";
import { Shell, Thread } from "./thread";

export const name = "In the thread";

function Row({ line, live, mine }: { line: Line; live: boolean; mine: boolean }) {
  const { edit, remove } = useMemory();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(line.text);
  return (
    <li className="group flex items-start gap-2 py-1 text-sm">
      <span
        title={live ? "In the Bot's prompt" : "Found only by search"}
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          live ? "bg-emerald-500" : "bg-muted-foreground/30",
        )}
      />
      {editing ? (
        <input
          autoFocus
          className="flex-1 rounded border px-1"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              edit(line.id, text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="flex-1">
          {line.date && (
            <span className="mr-1 font-mono text-[11px] text-muted-foreground">{line.date}</span>
          )}
          {line.text}
          {!mine && <span className="ml-1 text-[11px] text-muted-foreground">· {line.bot}</span>}
        </span>
      )}
      {mine && (
        <span className="flex gap-1 opacity-0 group-hover:opacity-100">
          <button type="button" onClick={() => setEditing(true)}>
            <PencilIcon className="size-3.5" />
          </button>
          <button type="button" onClick={() => remove(line.id)}>
            <XIcon className="size-3.5" />
          </button>
        </span>
      )}
    </li>
  );
}

function Section({ tier }: { tier: Tier }) {
  const { lines, add } = useMemory();
  const live = inPrompt(lines);
  const rows = lines.filter((l) => l.tier === tier && (tier === "profile" || l.bot === thisBot));
  const [draft, setDraft] = useState("");
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {tierLabel[tier]}
        {tier === "profile" && <span className="ml-1 normal-case">(shared by all your Bots)</span>}
      </h3>
      <ul>
        {rows.map((l) => (
          <Row key={l.id} line={l} live={live.has(l.id)} mine={l.bot === thisBot} />
        ))}
      </ul>
      <div className="flex items-center gap-1">
        <PlusIcon className="size-3.5 text-muted-foreground" />
        <input
          className="flex-1 bg-transparent text-sm outline-none"
          placeholder={`Add to ${tierLabel[tier]}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft) {
              add(tier, draft);
              setDraft("");
            }
          }}
        />
      </div>
    </section>
  );
}

function Chip({ changes, index, undone }: { changes: Change[]; index: number; undone?: boolean }) {
  const { undo } = useMemory();
  const [open, setOpen] = useState(false);
  return (
    <div className="self-start text-xs text-muted-foreground">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
        onClick={() => setOpen(!open)}
      >
        <BrainIcon className="size-3" />
        {undone ? "Memory change undone" : `Memory updated · ${changes.length}`}
      </button>
      {open && !undone && (
        <ul className="mt-1 flex flex-col gap-0.5 rounded-lg border p-2">
          {changes.map((c, i) => (
            <li key={i}>
              {c.kind === "add" ? "+" : c.kind === "remove" ? "−" : "~"} {tierLabel[c.tier]}:{" "}
              {c.text}
            </li>
          ))}
          <button type="button" className="self-start underline" onClick={() => undo(index)}>
            Undo
          </button>
        </ul>
      )}
    </div>
  );
}

export function VariantA() {
  return (
    <Shell
      header={
        <Popover>
          <PopoverTrigger className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
            <BrainIcon className="size-3.5" /> Memory
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex max-h-[70vh] w-96 flex-col gap-4 overflow-auto"
          >
            <Section tier="profile" />
            <Section tier="log" />
            <Section tier="notes" />
            <p className="text-[11px] text-muted-foreground">
              ● in the Bot's prompt · ○ found by search
            </p>
          </PopoverContent>
        </Popover>
      }
    >
      <Thread
        renderChanges={(changes, i, item) => (
          <Chip changes={changes} index={i} undone={item.undone} />
        )}
      />
    </Shell>
  );
}
