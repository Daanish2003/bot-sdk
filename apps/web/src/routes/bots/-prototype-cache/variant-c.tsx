// PROTOTYPE (#663) variant C, "Heat strip": a strip under the header, one column per model call
// across the whole Conversation and one row per section. A Summary is a vertical rule. Click a
// column to jump to its Turn; the thread itself shows only a badge on a Turn with a bug miss.
import { useState } from "react";

import { allSteps, fmt, sectionNames, statusClass, statusLabel, totals } from "./mock";
import { Shell, Thread } from "./thread";

export const name = "Heat strip";

function Strip({ onPick, picked }: { onPick: (i: number) => void; picked?: number }) {
  const all = totals(allSteps.map((x) => x.step));
  const pick = picked !== undefined ? allSteps[picked] : undefined;
  return (
    <div className="border-b bg-muted/30 px-4 py-2">
      <div className="flex gap-3">
        <div className="flex flex-col gap-px pt-4 text-[10px] text-muted-foreground">
          {sectionNames.map((n) => (
            <div key={n} className="h-3 leading-3">
              {n}
            </div>
          ))}
          <div className="h-6 leading-6">cached</div>
        </div>
        <div className="flex gap-px overflow-x-auto">
          {allSteps.map(({ item, step }, i) => {
            const t = totals([step]);
            const isSummary = item.kind === "summary";
            return (
              <button
                type="button"
                key={step.id}
                onClick={() => onPick(i)}
                className={`flex flex-col gap-px rounded-sm p-px ${picked === i ? "ring-2 ring-sky-400" : ""} ${isSummary ? "mx-1 border-x-2 border-sky-400" : ""}`}
                title={`${item.kind === "turn" ? "Turn" : item.kind} ${"at" in item ? item.at : ""} · ${step.label} · ${fmt.pct(t.hitRate)} cached · ${fmt.usd(t.cost)}`}
              >
                <div className="h-3 text-center text-[9px] leading-3 text-muted-foreground">
                  {item.kind === "warm" ? "W" : isSummary ? "Σ" : ""}
                </div>
                {step.sections.map((s) => (
                  <div key={s.name} className={`h-3 w-4 ${statusClass[s.status]}`} />
                ))}
                <div className="flex h-6 w-4 items-end bg-background">
                  <div
                    className="w-full bg-emerald-600"
                    style={{ height: `${t.hitRate * 100}%` }}
                  />
                </div>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex flex-col justify-between text-right text-xs">
          <div>
            <div className="text-lg font-semibold">{fmt.pct(all.hitRate)}</div>
            <div className="text-muted-foreground">cached · {fmt.usd(all.cost)} spent</div>
            <div className="text-muted-foreground">{fmt.usd(all.saved)} saved</div>
          </div>
          <div className="flex flex-col items-end gap-0.5 text-[10px] text-muted-foreground">
            {(["hit", "write", "miss", "fresh"] as const).map((k) => (
              <span key={k} className="flex items-center gap-1">
                {statusLabel[k]}
                <span className={`inline-block h-2 w-3 rounded-sm ${statusClass[k]}`} />
              </span>
            ))}
          </div>
        </div>
      </div>
      {pick && (
        <div className="mt-2 rounded-md bg-background p-2 font-mono text-[11px]">
          {pick.item.kind} {"at" in pick.item ? pick.item.at : ""} · {pick.step.label} · read{" "}
          {fmt.tokens(pick.step.read)} · written {fmt.tokens(pick.step.write)} · uncached{" "}
          {fmt.tokens(pick.step.uncached)} · out {fmt.tokens(pick.step.output)} ·{" "}
          {fmt.usd(pick.step.cost)}
          <div className="mt-1 flex flex-wrap gap-x-3">
            {pick.step.sections.map((s) => (
              <span
                key={s.name}
                className={s.status === "miss" ? "text-red-600" : "text-muted-foreground"}
              >
                {s.name}#{s.hash.slice(0, 6)}
                {s.was ? ` (was #${s.was.slice(0, 6)})` : ""}
              </span>
            ))}
          </div>
          {pick.step.bug && (
            <div className="text-red-600">⚠ cache miss at {pick.step.bug}: a bug</div>
          )}
          {pick.step.expected && (
            <div className="text-muted-foreground">{pick.step.expected}: expected</div>
          )}
        </div>
      )}
    </div>
  );
}

export function VariantC() {
  const [picked, setPicked] = useState<number>();
  return (
    <Shell
      top={
        <Strip
          picked={picked}
          onPick={(i) => {
            setPicked(i);
            const item = allSteps[i].item;
            if (item.kind === "turn")
              document
                .getElementById(`turn-${item.id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
        />
      }
    >
      <Thread
        afterTurn={(turn) => {
          const bug = turn.steps.find((s) => s.bug);
          return bug ? (
            <span className="self-start rounded bg-red-100 px-1.5 text-[11px] text-red-700 dark:bg-red-950 dark:text-red-300">
              ⚠ cache miss: {bug.bug}
            </span>
          ) : null;
        }}
        warm={() => null}
        summary={(s) => (
          <div className="flex items-center gap-2 text-[11px] text-sky-600">
            <div className="h-px flex-1 bg-sky-300" />Σ Summary {s.at}
            <div className="h-px flex-1 bg-sky-300" />
          </div>
        )}
      />
    </Shell>
  );
}
