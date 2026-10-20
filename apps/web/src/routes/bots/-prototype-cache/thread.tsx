// PROTOTYPE (#663): a bare Bot thread the variants share; each decides how cache detail shows.
import type { ReactNode } from "react";

import { type ThreadItem, thread } from "./mock";

type Turn = Extract<ThreadItem, { kind: "turn" }>;
type Warm = Extract<ThreadItem, { kind: "warm" }>;
type Summary = Extract<ThreadItem, { kind: "summary" }>;

export function Shell({
  header,
  top,
  children,
  side,
}: {
  header?: ReactNode;
  top?: ReactNode;
  children: ReactNode;
  side?: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <span className="font-semibold">Planner</span>
        <span className="text-xs text-muted-foreground">Bot · claude-sonnet-5-5</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-md border px-2 py-1 text-xs text-muted-foreground">
            Routines 2
          </span>
          <span className="rounded-md border px-2 py-1 text-xs text-muted-foreground">Memory</span>
          {header}
        </div>
      </header>
      {top}
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        {side}
      </div>
    </div>
  );
}

export function Thread({
  afterTurn,
  warm,
  summary,
  turnClass,
  onTurn,
  dimBefore,
}: {
  afterTurn?: (turn: Turn) => ReactNode;
  warm: (item: Warm) => ReactNode;
  summary: (item: Summary) => ReactNode;
  turnClass?: (turn: Turn) => string;
  onTurn?: (turn: Turn) => void;
  /** Index of a Summary: items before it are drawn faded. */
  dimBefore?: number;
}) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto p-4 pb-24">
      {thread.map((item, i) => {
        const faded = dimBefore !== undefined && i < dimBefore ? "opacity-45" : "";
        if (item.kind === "user")
          return (
            <div
              key={i}
              className={`max-w-[70%] self-end rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground ${faded}`}
            >
              {item.text}
            </div>
          );
        if (item.kind === "trigger")
          return (
            <div key={i} className={`self-center text-xs text-muted-foreground ${faded}`}>
              ⏰ {item.at} · {item.text}
            </div>
          );
        if (item.kind === "warm") return <div key={i}>{warm(item)}</div>;
        if (item.kind === "summary") return <div key={i}>{summary(item)}</div>;
        return (
          <div
            key={i}
            id={`turn-${item.id}`}
            onClick={onTurn ? () => onTurn(item) : undefined}
            className={`flex max-w-[70%] flex-col gap-1 self-start rounded-xl ${onTurn ? "cursor-pointer" : ""} ${turnClass?.(item) ?? ""} ${faded}`}
          >
            {item.messages.map((m, j) => (
              <div key={j} className="rounded-2xl bg-muted px-3 py-2 text-sm">
                {m}
              </div>
            ))}
            {afterTurn?.(item)}
          </div>
        );
      })}
    </div>
  );
}
