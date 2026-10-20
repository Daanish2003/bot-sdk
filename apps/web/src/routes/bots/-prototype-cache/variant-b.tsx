// PROTOTYPE (#663) variant B, "Inspector panel": a header button opens a right-hand panel; click a
// Turn to inspect it. Each Step is a bar of the prompt, sections sized by tokens. Older Messages fade
// above the Summary line.
import { useState } from "react";

import {
  type Step,
  type ThreadItem,
  allSteps,
  fmt,
  statusClass,
  statusLabel,
  thread,
  totals,
} from "./mock";
import { Shell, Thread } from "./thread";

export const name = "Inspector panel";

type Inspectable = Extract<ThreadItem, { kind: "turn" | "warm" | "summary" }>;

function PromptBar({ step }: { step: Step }) {
  const total = step.sections.reduce((n, s) => n + s.tokens, 0) || 1;
  return (
    <div className="flex h-5 w-full overflow-hidden rounded">
      {step.sections
        .filter((s) => s.tokens > 0)
        .map((s) => (
          <div
            key={s.name}
            className={`${statusClass[s.status]} border-r border-background/60`}
            style={{ width: `${Math.max(1.5, (s.tokens / total) * 100)}%` }}
            title={`${s.name} · ${fmt.tokens(s.tokens)} · #${s.hash} · ${statusLabel[s.status]}`}
          />
        ))}
    </div>
  );
}

function StepDetail({ step }: { step: Step }) {
  const t = totals([step]);
  return (
    <div className="space-y-1.5 rounded-lg border p-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{step.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {fmt.tokens(t.input)} in · {fmt.pct(t.hitRate)} cached · {fmt.usd(t.cost)}
        </span>
      </div>
      <PromptBar step={step} />
      {step.bug && (
        <p className="text-xs text-red-600">
          ⚠ First changed section: <b>{step.bug}</b>. Everything after it was written again.
        </p>
      )}
      {step.expected && (
        <p className="text-xs text-muted-foreground">{step.expected} (expected).</p>
      )}
      <table className="w-full text-[11px]">
        <tbody>
          {step.sections.map((s) => (
            <tr key={s.name} className={s.status === "miss" ? "text-red-600" : ""}>
              <td className="py-0.5">
                <span
                  className={`mr-1 inline-block h-2 w-2 rounded-full ${statusClass[s.status]}`}
                />
                {s.name}
              </td>
              <td className="text-right tabular-nums">{fmt.tokens(s.tokens)}</td>
              <td className="pl-2 font-mono text-muted-foreground">
                {s.was ? `#${s.was.slice(0, 4)} → ` : ""}#{s.hash.slice(0, 6)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({ selected, onClose }: { selected?: Inspectable; onClose: () => void }) {
  const all = totals(allSteps.map((x) => x.step));
  const steps = selected ? (selected.kind === "turn" ? selected.steps : [selected.step]) : [];
  return (
    <aside className="flex w-[26rem] flex-col gap-3 overflow-auto border-l p-3 pb-24">
      <div className="flex items-center justify-between">
        <span className="font-semibold">Prompt cache</span>
        <button type="button" onClick={onClose} className="text-xs text-muted-foreground">
          ✕
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg bg-muted p-2">
          <div className="text-lg font-semibold">{fmt.pct(all.hitRate)}</div>
          read from cache today
        </div>
        <div className="rounded-lg bg-muted p-2">
          <div className="text-lg font-semibold">{fmt.usd(all.cost)}</div>
          spent
        </div>
        <div className="rounded-lg bg-muted p-2">
          <div className="text-lg font-semibold">{fmt.usd(all.saved)}</div>
          saved by caching
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        {(["hit", "write", "miss", "fresh"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className={`inline-block h-2 w-3 rounded-sm ${statusClass[k]}`} />
            {statusLabel[k]}
          </span>
        ))}
      </div>
      {selected ? (
        <>
          <div className="text-xs text-muted-foreground">
            {selected.kind === "turn"
              ? `Turn at ${selected.at}`
              : selected.kind === "warm"
                ? `Warming call at ${selected.at}`
                : `Summary at ${selected.at}`}
          </div>
          {steps.map((s) => (
            <StepDetail key={s.id} step={s} />
          ))}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Click a Turn in the thread to inspect its Steps.
        </p>
      )}
    </aside>
  );
}

export function VariantB() {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<Inspectable | undefined>(
    thread.find((x) => x.kind === "turn" && x.steps.some((s) => s.bug)) as Inspectable,
  );
  const summaryIndex = thread.findIndex((x) => x.kind === "summary");
  const hasBug = allSteps.some((x) => x.step.bug);
  const ring = (id: string) =>
    selected && "id" in selected && selected.id === id ? "ring-2 ring-sky-400" : "";
  return (
    <Shell
      header={
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={`rounded-md border px-2 py-1 text-xs ${hasBug ? "border-red-400 text-red-600" : ""}`}
        >
          Cache {hasBug ? "⚠" : ""}
        </button>
      }
      side={open && <Panel selected={selected} onClose={() => setOpen(false)} />}
    >
      <Thread
        dimBefore={summaryIndex}
        onTurn={(t) => {
          setSelected(t);
          setOpen(true);
        }}
        turnClass={(t) =>
          `${ring(t.id)} ${t.steps.some((s) => s.bug) ? "border-l-4 border-red-400 pl-1" : ""}`
        }
        warm={(w) => (
          <button
            type="button"
            onClick={() => {
              setSelected(w);
              setOpen(true);
            }}
            className={`w-full text-center text-[11px] text-muted-foreground ${ring(w.id)}`}
          >
            · cache warmed {w.at} ·
          </button>
        )}
        summary={(s) => (
          <button
            type="button"
            onClick={() => {
              setSelected(s);
              setOpen(true);
            }}
            className={`w-full rounded-lg border-2 border-dashed border-sky-300 p-2 text-left text-xs ${ring(s.id)}`}
          >
            <div className="font-medium">Above this line the Bot works from a Summary ({s.at})</div>
            <div className="text-muted-foreground">{s.text}</div>
            <div className="mt-1 text-muted-foreground">
              + its last {s.kept.length} Messages to you, word for word
            </div>
          </button>
        )}
      />
    </Shell>
  );
}
