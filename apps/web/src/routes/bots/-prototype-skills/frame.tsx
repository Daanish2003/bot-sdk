// PROTOTYPE (#711): the bare Bot page and small pieces the variants share. Each variant decides
// where the Demonstration, the "Skill saved" line and the Skills list go.
import { type ReactNode, useState } from "react";

import type { Demonstration, Item, Skill } from "./stub";

export function Frame({
  header,
  children,
  side,
  overlay,
}: {
  header?: ReactNode;
  children: ReactNode;
  side?: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div className="relative flex h-dvh flex-col bg-background">
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
            <div className="rounded-xl border px-3 py-2 text-sm text-muted-foreground">
              Message Planner…
            </div>
          </div>
        </main>
        {side}
      </div>
      {overlay}
    </div>
  );
}

export function Thread({
  items,
  demo,
  saved,
}: {
  items: Item[];
  demo: () => ReactNode;
  saved: (item: Extract<Item, { kind: "skill-saved" }>) => ReactNode;
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
        if (item.kind === "demo") return <div key={i}>{demo()}</div>;
        return <div key={i}>{saved(item)}</div>;
      })}
    </>
  );
}

/** A stand-in for the noVNC live view: a browser window showing the last navigated URL. */
export function FakeScreen({ demo, big }: { demo: Demonstration; big?: boolean }) {
  const url = [...demo.events].reverse().find((e) => e.kind === "navigate")?.text ?? "about:blank";
  const last = demo.events.at(-1);
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-lg border bg-white text-black ${big ? "h-full" : "h-44"}`}
    >
      <div className="flex items-center gap-2 border-b bg-neutral-100 px-2 py-1 text-[11px]">
        <span className="size-2 rounded-full bg-neutral-300" />
        <span className="truncate rounded bg-white px-2 py-0.5 text-neutral-600">{url}</span>
      </div>
      <div className="relative flex flex-1 items-center justify-center text-xs text-neutral-400">
        {demo.status === "paused" ? (
          <span className="rounded bg-neutral-800 px-2 py-1 text-white">
            Paused: the Bot sees nothing now
          </span>
        ) : last ? (
          <span>
            last: {last.kind} {last.text}
          </span>
        ) : (
          <span>Chrome on the Screen</span>
        )}
      </div>
    </div>
  );
}

export const statusText: Record<Demonstration["status"], string> = {
  recording: "Recording",
  paused: "Paused",
  drafting: "Writing the Skill…",
  saved: "Saved as a Skill",
  cancelled: "Cancelled",
};

export function RecDot({ demo }: { demo: Demonstration }) {
  if (demo.status === "recording")
    return <span className="size-2 animate-pulse rounded-full bg-red-500" />;
  if (demo.status === "paused") return <span className="size-2 rounded-full bg-amber-500" />;
  return <span className="size-2 rounded-full bg-neutral-400" />;
}

export function EventList({ demo, compact }: { demo: Demonstration; compact?: boolean }) {
  const events = compact ? demo.events.slice(-4) : demo.events;
  return (
    <ol className="flex flex-col gap-0.5 text-xs">
      {events.map((e, i) => (
        <li key={i} className="flex gap-2">
          <span className="w-8 shrink-0 font-mono text-muted-foreground">{e.at}</span>
          <span className="w-16 shrink-0 text-muted-foreground">{e.kind}</span>
          <span className={e.masked ? "italic text-muted-foreground" : ""}>{e.text}</span>
        </li>
      ))}
      {demo.events.length === 0 && <li className="text-muted-foreground">Nothing yet.</li>}
    </ol>
  );
}

/** The raw SKILL.md, editable; Save writes it, Delete removes the folder. */
export function SkillEditor({
  skill,
  onSave,
  onDelete,
}: {
  skill: Skill;
  onSave: (body: string) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(skill.body);
  return (
    <div className="flex flex-col gap-2">
      {skill.problem && (
        <div className="rounded-md border border-amber-400 bg-amber-50 px-2 py-1 text-xs text-amber-900">
          Not usable: {skill.problem}. Planner sees this and can fix it, or you can.
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-h-48 w-full rounded-md border bg-background p-2 font-mono text-xs"
      />
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          skills/{skill.name}/SKILL.md · saved by {skill.savedBy}, {skill.updatedAt}
        </span>
        <button type="button" className="ml-auto rounded-md border px-2 py-1" onClick={onDelete}>
          Delete
        </button>
        <button
          type="button"
          className="rounded-md bg-primary px-2 py-1 text-primary-foreground"
          onClick={() => onSave(text)}
        >
          Save
        </button>
      </div>
    </div>
  );
}
