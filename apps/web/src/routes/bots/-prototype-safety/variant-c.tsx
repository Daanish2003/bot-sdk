// PROTOTYPE (#689) variant C, "Safety rail": a standing right column is the one place for safety.
// Waiting requests pin to its top with a countdown bar and Allow / Deny; below, a timeline of every
// reviewed call grouped by who made it (Planner or a Helper), then the Secrets. The thread carries
// only small chips that point at the rail. A Secret is entered in a dialog opened from the Bot's
// message, never in the thread itself.
import { Button } from "@/components/ui/button";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { Frame, Thread, whoText } from "./frame";
import { APPROVAL_MS, type Review, type Stub, reviews, secondsLeft, waiting } from "./stub";

export const name = "Safety rail";

const mark = (r: Review) =>
  r.verdict === "pass"
    ? { icon: "✓", text: "Auto-approved", tone: "text-emerald-600" }
    : r.approval?.state === "allowed"
      ? { icon: "✓", text: "You allowed", tone: "text-emerald-600" }
      : r.approval?.state === "denied"
        ? { icon: "✕", text: "You denied", tone: "text-red-600" }
        : r.approval?.state === "expired"
          ? { icon: "✕", text: "Blocked, no answer in 15 s", tone: "text-red-600" }
          : { icon: "⏳", text: "Waiting for you", tone: "text-amber-600" };

export function VariantC({ stub }: { stub: Stub }) {
  const [dialog, setDialog] = useState<{ id: string; name: string; why: string } | null>(null);
  return (
    <Frame side={<Rail stub={stub} />}>
      <Thread
        items={stub.items}
        review={(r) => {
          const m = mark(r);
          return (
            <a
              href={`#rail-${r.id}`}
              className={`inline-flex max-w-[70%] items-center gap-1 self-start rounded-full border px-2 py-0.5 text-xs ${m.tone}`}
            >
              {m.icon} {r.summary}
              {r.approval?.state === "waiting" ? ` · ${secondsLeft(r.approval, stub.now)}s →` : ""}
            </a>
          );
        }}
        secret={(request) => (
          <div className="flex max-w-[70%] flex-col gap-1 self-start rounded-2xl bg-muted px-3 py-2 text-sm">
            {request.why}
            {request.saved ? (
              <span className="text-xs text-muted-foreground">🔑 {request.name} saved</span>
            ) : (
              <Button size="sm" className="self-start" onClick={() => setDialog(request)}>
                <KeyRoundIcon className="size-3" /> Enter {request.name} securely
              </Button>
            )}
          </div>
        )}
      />
      {dialog && (
        <SecretDialog
          name={dialog.name}
          why={dialog.why}
          onClose={() => setDialog(null)}
          onSave={() => {
            stub.saveSecret(dialog.id, dialog.name);
            setDialog(null);
          }}
        />
      )}
    </Frame>
  );
}

function Rail({ stub }: { stub: Stub }) {
  const queue = waiting(stub.items);
  const done = reviews(stub.items).filter((r) => r.approval?.state !== "waiting");
  const groups = new Map<string, Review[]>();
  for (const r of [...done].reverse())
    groups.set(whoText(r), [...(groups.get(whoText(r)) ?? []), r]);
  return (
    <aside className="flex w-80 flex-col gap-3 overflow-auto border-l p-3">
      <div className="text-sm font-semibold">Safety</div>
      {queue.map((r) => {
        const fraction = Math.max(0, (r.approval!.deadline - stub.now) / APPROVAL_MS);
        return (
          <div
            id={`rail-${r.id}`}
            key={r.id}
            className="flex flex-col gap-2 rounded-lg border border-amber-400 p-2"
          >
            <div className="text-xs text-muted-foreground">{whoText(r)}</div>
            <div className="text-sm font-medium">{r.summary}</div>
            <div className="text-xs">{r.reason}</div>
            <div className="h-1 rounded bg-amber-100">
              <div
                className="h-full rounded bg-amber-500"
                style={{ width: `${fraction * 100}%` }}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => stub.decide(r.id, true)}>
                Allow · {secondsLeft(r.approval!, stub.now)}s
              </Button>
              <Button size="sm" variant="outline" onClick={() => stub.decide(r.id, false)}>
                Deny
              </Button>
            </div>
          </div>
        );
      })}
      {[...groups].map(([who, list]) => (
        <div key={who} className="flex flex-col gap-1">
          <div className="text-xs font-medium text-muted-foreground">{who}</div>
          <ol className="flex flex-col border-l pl-3">
            {list.map((r) => {
              const m = mark(r);
              return (
                <li
                  id={`rail-${r.id}`}
                  key={r.id}
                  className="relative py-1 text-sm"
                  title={`${r.tool}: ${r.args}`}
                >
                  <span className={`absolute -left-[17px] top-1.5 text-xs ${m.tone}`}>
                    {m.icon}
                  </span>
                  {r.summary}
                  <div className="text-xs text-muted-foreground">
                    {r.at} · {m.text} · {r.reason}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      <div className="mt-auto flex flex-col gap-1 border-t pt-2">
        <div className="text-xs font-medium text-muted-foreground">
          Secrets · shared by all your Bots
        </div>
        {stub.secrets.map((s) => (
          <div key={s.name} className="flex items-center gap-2 text-sm">
            <code>{s.name}</code>
            <span className="text-xs text-muted-foreground">{s.savedAt}</span>
            <button
              type="button"
              className="ml-auto text-xs text-red-600"
              onClick={() => stub.deleteSecret(s.name)}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

function SecretDialog({
  name,
  why,
  onClose,
  onSave,
}: {
  name: string;
  why: string;
  onClose: () => void;
  onSave: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex w-96 flex-col gap-3 rounded-xl bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 font-semibold">
          <KeyRoundIcon className="size-4" /> {name}
        </div>
        <div className="text-sm text-muted-foreground">{why}</div>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        />
        <div className="text-xs text-muted-foreground">
          Stored encrypted for all your Bots. Commands can use it; the model only ever sees “{name}
          ”.
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!value} onClick={onSave}>
            Save secret
          </Button>
        </div>
      </div>
    </div>
  );
}
