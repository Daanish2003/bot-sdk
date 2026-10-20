// PROTOTYPE (#623): a bare Bot thread the variants share; each decides how memory changes show.
import type { ReactNode } from "react";

import { type Change, type ThreadItem, thisBot, useMemory } from "./mock";

export function Shell({
  header,
  children,
  side,
}: {
  header: ReactNode;
  children: ReactNode;
  side?: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <span className="font-semibold">{thisBot}</span>
        <span className="text-xs text-muted-foreground">Bot</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-md border px-2 py-1 text-xs text-muted-foreground">
            Routines 2
          </span>
          <span className="rounded-md border px-2 py-1 text-xs text-muted-foreground">To-do 0</span>
          {header}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        {side}
      </div>
    </div>
  );
}

export function Thread({
  renderChanges,
}: {
  renderChanges: (
    changes: Change[],
    index: number,
    item: Extract<ThreadItem, { kind: "bot" }>,
  ) => ReactNode;
}) {
  const { thread } = useMemory();
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto p-4 pb-24">
      {thread.map((item, i) =>
        item.kind === "user" ? (
          <div
            key={i}
            className="max-w-[70%] self-end rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground"
          >
            {item.text}
          </div>
        ) : (
          <div key={i} className="flex max-w-[70%] flex-col gap-1 self-start">
            <div className="rounded-2xl bg-muted px-3 py-2 text-sm">{item.text}</div>
            {item.changes && renderChanges(item.changes, i, item)}
          </div>
        ),
      )}
    </div>
  );
}
