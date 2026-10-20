// PROTOTYPE (#689) variant B, "Takes the message box": the thread stays quiet. A waiting request
// replaces the message box, with a countdown ring and big Allow / Deny, and several queue as "1 of 2"
// whether or not a Turn is live; once closed, the thread keeps one muted line. Passes never show in
// the thread: the header's "Auto-review" counter opens a sheet listing every verdict, which also holds
// the Secrets. A Secret request also takes the message box, as a password field.
import { Button } from "@/components/ui/button";
import { KeyRoundIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Frame, Thread, whoText } from "./frame";
import {
  APPROVAL_MS,
  type Review,
  type Stub,
  closedText,
  reviews,
  secondsLeft,
  waiting,
} from "./stub";

export const name = "Takes the message box";

export function VariantB({ stub }: { stub: Stub }) {
  const [sheet, setSheet] = useState(false);
  const queue = waiting(stub.items);
  const pendingSecret = stub.items.find((i) => i.kind === "secret-request" && !i.saved);
  const passed = reviews(stub.items).filter((r) => r.verdict === "pass").length;

  const composer = queue.length ? (
    <Request review={queue[0]!} of={queue.length} stub={stub} />
  ) : pendingSecret && pendingSecret.kind === "secret-request" ? (
    <SecretBox
      name={pendingSecret.name}
      why={pendingSecret.why}
      onSave={() => stub.saveSecret(pendingSecret.id, pendingSecret.name)}
    />
  ) : undefined;

  return (
    <Frame
      header={
        <button
          type="button"
          onClick={() => setSheet(!sheet)}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
        >
          <ShieldCheckIcon className="size-3 text-emerald-600" /> Auto-review · {passed} passed
        </button>
      }
      composer={composer}
      side={sheet ? <Sheet stub={stub} onClose={() => setSheet(false)} /> : undefined}
    >
      <Thread
        items={stub.items}
        review={(review) =>
          review.verdict === "pass" || review.approval?.state === "waiting" ? null : (
            <div className="self-center text-xs text-muted-foreground">⛔ {closedText(review)}</div>
          )
        }
        secret={(request) =>
          request.saved ? (
            <div className="self-center text-xs text-muted-foreground">
              🔑 Saved secret {request.name}
            </div>
          ) : (
            <div className="max-w-[70%] self-start rounded-2xl bg-muted px-3 py-2 text-sm">
              {request.why}
            </div>
          )
        }
      />
    </Frame>
  );
}

function Request({ review, of, stub }: { review: Review; of: number; stub: Stub }) {
  const left = secondsLeft(review.approval!, stub.now);
  const fraction = Math.max(0, (review.approval!.deadline - stub.now) / APPROVAL_MS);
  return (
    <div className="flex items-center gap-4 rounded-xl border-2 border-amber-400 p-3">
      <Ring fraction={fraction} label={`${left}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-xs text-muted-foreground">
          {whoText(review)} wants to · {of > 1 ? `1 of ${of}` : "needs your OK"}
          {!stub.turnLive && review.by.kind === "helper" ? " · while you were away" : ""}
        </div>
        <div className="font-medium">{review.summary}</div>
        <div className="text-sm text-muted-foreground">{review.reason}</div>
      </div>
      <div className="flex flex-col gap-1">
        <Button onClick={() => stub.decide(review.id, true)}>Allow</Button>
        <Button variant="outline" onClick={() => stub.decide(review.id, false)}>
          Deny
        </Button>
      </div>
    </div>
  );
}

function Ring({ fraction, label }: { fraction: number; label: string }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" className="shrink-0">
      <circle
        cx="24"
        cy="24"
        r={r}
        fill="none"
        stroke="currentColor"
        className="text-muted"
        strokeWidth="4"
      />
      <circle
        cx="24"
        cy="24"
        r={r}
        fill="none"
        stroke="currentColor"
        className="text-amber-500"
        strokeWidth="4"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - fraction)}
        transform="rotate(-90 24 24)"
      />
      <text x="24" y="29" textAnchor="middle" className="fill-current text-sm font-semibold">
        {label}
      </text>
    </svg>
  );
}

function SecretBox({ name, why, onSave }: { name: string; why: string; onSave: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="flex items-center gap-2 rounded-xl border-2 border-sky-400 p-2">
      <KeyRoundIcon className="size-4 shrink-0" />
      <input
        type="password"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`${name}: only the name reaches Planner`}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        title={why}
      />
      <Button size="sm" disabled={!value} onClick={onSave}>
        Save secret
      </Button>
    </div>
  );
}

function Sheet({ stub, onClose }: { stub: Stub; onClose: () => void }) {
  const [tab, setTab] = useState<"reviews" | "secrets">("reviews");
  return (
    <aside className="flex w-96 flex-col border-l">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        {(["reviews", "secrets"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded px-2 py-0.5 ${tab === t ? "bg-muted font-medium" : "text-muted-foreground"}`}
          >
            {t === "reviews" ? "Auto-review" : `Secrets ${stub.secrets.length}`}
          </button>
        ))}
        <button type="button" className="ml-auto" onClick={onClose} aria-label="Close">
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="flex flex-col gap-1 overflow-auto p-2">
        {tab === "reviews"
          ? [...reviews(stub.items)].reverse().map((r) => (
              <div key={r.id} className="rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                <div className="flex items-center gap-1">
                  {r.verdict === "pass"
                    ? "✓"
                    : r.approval?.state === "allowed"
                      ? "✓"
                      : r.approval?.state === "waiting"
                        ? "⏳"
                        : "⛔"}
                  <span className="truncate">{r.summary}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{r.at}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {r.verdict === "pass" ? "Auto-approved" : closedText(r).split(":")[0]} ·{" "}
                  {r.reason}
                </div>
                <code className="block truncate text-[11px] text-muted-foreground">{r.args}</code>
              </div>
            ))
          : stub.secrets.map((s) => (
              <div
                key={s.name}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              >
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
