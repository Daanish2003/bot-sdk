// PROTOTYPE (#663) variant A, "Under each Turn": a chip under the Turn's Messages that expands
// inline into a per-Step grid of sections. Summaries and warming are cards in the thread.
import { useState } from "react";

import { type Step, fmt, sectionNames, statusClass, statusLabel, totals } from "./mock";
import { Shell, Thread } from "./thread";

export const name = "Under each Turn";

function StepGrid({ steps }: { steps: Step[] }) {
  return (
    <div className="mt-1 rounded-lg border bg-background p-2 text-xs">
      <table className="w-full">
        <thead>
          <tr className="text-muted-foreground">
            <th className="pr-2 text-left font-normal">Step</th>
            {sectionNames.map((n) => (
              <th key={n} className="px-0.5 text-[10px] font-normal" title={n}>
                {n.split(" ")[0].slice(0, 4)}
              </th>
            ))}
            <th className="pl-2 text-right font-normal">cached</th>
            <th className="pl-2 text-right font-normal">cost</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const t = totals([s]);
            return (
              <tr key={s.id}>
                <td className="pr-2">{s.label}</td>
                {s.sections.map((sec) => (
                  <td key={sec.name} className="px-0.5">
                    <div
                      className={`mx-auto h-3 w-5 rounded-sm ${statusClass[sec.status]}`}
                      title={`${sec.name} · ${fmt.tokens(sec.tokens)} · #${sec.hash}${sec.was ? ` (was #${sec.was})` : ""} · ${statusLabel[sec.status]}`}
                    />
                  </td>
                ))}
                <td className="pl-2 text-right tabular-nums">{fmt.pct(t.hitRate)}</td>
                <td className="pl-2 text-right tabular-nums">{fmt.usd(t.cost)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {steps.map(
        (s) =>
          (s.bug || s.expected) && (
            <p key={s.id} className={`mt-1 ${s.bug ? "text-red-600" : "text-muted-foreground"}`}>
              {s.label}:{" "}
              {s.bug
                ? `cache miss at "${s.bug}" (#${s.sections.find((x) => x.name === s.bug)?.was} → #${s.sections.find((x) => x.name === s.bug)?.hash}). Everything after it was written again. This is a bug.`
                : `${s.expected}: written once, expected.`}
            </p>
          ),
      )}
      <Legend />
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
      {(["hit", "write", "miss", "fresh"] as const).map((k) => (
        <span key={k} className="flex items-center gap-1">
          <span className={`inline-block h-2 w-3 rounded-sm ${statusClass[k]}`} />
          {statusLabel[k]}
        </span>
      ))}
    </div>
  );
}

function Chip({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false);
  const t = totals(steps);
  const bug = steps.find((s) => s.bug);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`rounded-full border px-2 py-0.5 text-[11px] ${bug ? "border-red-400 text-red-600" : "text-muted-foreground"}`}
      >
        {bug ? `⚠ Cache miss: ${bug.bug}` : `Cache ${fmt.pct(t.hitRate)}`} · {steps.length}{" "}
        {steps.length === 1 ? "Step" : "Steps"} · {fmt.usd(t.cost)} {open ? "▴" : "▾"}
      </button>
      {open && <StepGrid steps={steps} />}
    </div>
  );
}

export function VariantA() {
  return (
    <Shell>
      <Thread
        afterTurn={(turn) => <Chip steps={turn.steps} />}
        warm={(w) => (
          <div className="self-center text-center text-[11px] text-muted-foreground">
            Cache warmed at {w.at} when you opened the chat · {fmt.tokens(w.step.write)} written ·{" "}
            {fmt.usd(w.step.cost)}
          </div>
        )}
        summary={(s) => <SummaryCard item={s} />}
      />
    </Shell>
  );
}

function SummaryCard({
  item,
}: {
  item: { at: string; type: string; text: string; kept: string[]; step: Step };
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 flex items-center gap-2 text-xs text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      <div className="max-w-[70%] rounded-lg border bg-background px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="font-medium text-foreground"
        >
          📝 Summarized while you were away · {item.at} {open ? "▴" : "▾"}
        </button>
        <div>
          The Bot now works from this Summary instead of the earlier Messages ·{" "}
          {fmt.usd(item.step.cost)}
        </div>
        {open && (
          <div className="mt-2 space-y-2 text-foreground">
            <p>{item.text}</p>
            <div>
              <div className="text-muted-foreground">Kept word for word:</div>
              {item.kept.map((k) => (
                <blockquote key={k} className="border-l-2 pl-2">
                  {k}
                </blockquote>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
