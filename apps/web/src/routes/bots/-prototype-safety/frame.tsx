// PROTOTYPE (#689): the bare Bot page the variants share; each decides how reviews and Secrets show.
import type { ReactNode } from "react";

import type { Item, Review } from "./stub";

type SecretRequest = Extract<Item, { kind: "secret-request" }>;
type HelperItem = Extract<Item, { kind: "helper" }>;

export function Frame({
  header,
  children,
  composer,
  side,
}: {
  header?: ReactNode;
  children: ReactNode;
  /** Replaces the message box when given. */
  composer?: ReactNode;
  side?: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col bg-background">
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
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-1 flex-col gap-3 overflow-auto p-4 pb-24">{children}</div>
          <div className="border-t p-3">
            {composer ?? (
              <div className="rounded-xl border px-3 py-2 text-sm text-muted-foreground">
                Message Planner…
              </div>
            )}
          </div>
        </main>
        {side}
      </div>
    </div>
  );
}

/** Draws the thread; reviews, Secret requests and Helpers are drawn by the variant. */
export function Thread({
  items,
  review,
  secret,
  helper,
}: {
  items: Item[];
  review: (item: Review) => ReactNode;
  secret: (item: SecretRequest) => ReactNode;
  helper?: (item: HelperItem) => ReactNode;
}) {
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === "user")
          return (
            <div
              key={i}
              className="max-w-[70%] self-end rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground"
            >
              {item.text}
            </div>
          );
        if (item.kind === "bot")
          return (
            <div key={i} className="max-w-[70%] self-start rounded-2xl bg-muted px-3 py-2 text-sm">
              {item.text}
            </div>
          );
        if (item.kind === "trigger")
          return (
            <div key={i} className="self-center text-xs text-muted-foreground">
              ⚡ {item.at} · {item.text}
            </div>
          );
        if (item.kind === "helper")
          return (
            <div key={i}>
              {helper?.(item) ?? (
                <div className="max-w-md self-start rounded-xl border px-3 py-2 text-xs text-muted-foreground">
                  🧭 {item.helper} · {item.task}
                </div>
              )}
            </div>
          );
        if (item.kind === "secret-request") return <div key={i}>{secret(item)}</div>;
        return <div key={i}>{review(item)}</div>;
      })}
    </>
  );
}

/** Who asked: "Planner" or "Planner's Browser helper", with the Helper's task. */
export function whoText(review: Review) {
  return review.by.kind === "helper" ? `${review.by.helper} · ${review.by.task}` : "Planner";
}
