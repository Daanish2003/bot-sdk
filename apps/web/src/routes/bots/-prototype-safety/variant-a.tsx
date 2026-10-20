// PROTOTYPE (#689) variant A, "In the thread": every verdict sits where the call happened. A pass is a
// one-line "✓ Auto-approved: …" (slide 7); a block is a card with a draining bar and Allow / Deny that
// closes into a one-line divider; a Helper's request is nested under that Helper's line. A Secret is
// asked for with an inline masked-field card; the Secrets list is a header popover.
import { Button } from "@/components/ui/button";
import { KeyRoundIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldXIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Frame, Thread } from "./frame";
import { APPROVAL_MS, type Review, type Stub, closedText, reviews, secondsLeft } from "./stub";

export const name = "In the thread";

export function VariantA({ stub }: { stub: Stub }) {
  return (
    <Frame header={<SecretsPopover stub={stub} />}>
      <Thread
        items={stub.items}
        // A Helper's reviews are drawn inside its Helper line, not at their own place in the thread.
        review={(review) =>
          review.by.kind === "helper" ? null : <ReviewLine review={review} stub={stub} />
        }
        helper={(helper) => (
          <div className="flex max-w-md flex-col gap-2 self-start rounded-xl border px-3 py-2">
            <div className="text-xs text-muted-foreground">
              🧭 {helper.helper} · {helper.task} · <span className="text-emerald-600">working</span>
            </div>
            {reviews(stub.items)
              .filter((r) => r.by.kind === "helper")
              .map((r) => (
                <ReviewLine key={r.id} review={r} stub={stub} />
              ))}
          </div>
        )}
        secret={(request) =>
          request.saved ? (
            <Divider
              icon={<KeyRoundIcon className="size-3" />}
              text={`Saved secret ${request.name}`}
            />
          ) : (
            <SecretCard
              name={request.name}
              why={request.why}
              onSave={() => stub.saveSecret(request.id, request.name)}
            />
          )
        }
      />
    </Frame>
  );
}

function ReviewLine({ review, stub }: { review: Review; stub: Stub }) {
  if (review.verdict === "pass")
    return (
      <Divider
        icon={<ShieldCheckIcon className="size-3 text-emerald-600" />}
        text={`Auto-approved: ${review.summary}`}
        title={`${review.tool}: ${review.args}\n${review.reason}`}
      />
    );
  const approval = review.approval!;
  if (approval.state !== "waiting")
    return (
      <Divider
        icon={
          <ShieldXIcon
            className={`size-3 ${approval.state === "allowed" ? "text-emerald-600" : "text-red-600"}`}
          />
        }
        text={closedText(review)}
        title={review.reason}
      />
    );
  const left = secondsLeft(approval, stub.now);
  const fraction = Math.max(0, (approval.deadline - stub.now) / APPROVAL_MS);
  return (
    <div className="flex max-w-md flex-col gap-2 self-start overflow-hidden rounded-xl border border-amber-400 bg-amber-50 p-3 dark:bg-amber-950/30">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlertIcon className="size-4 text-amber-600" />
        {review.summary}
      </div>
      <div className="text-sm">{review.reason}</div>
      <code className="truncate rounded bg-background/70 px-2 py-1 text-xs">{review.args}</code>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => stub.decide(review.id, true)}>
          Allow
        </Button>
        <Button size="sm" variant="outline" onClick={() => stub.decide(review.id, false)}>
          Deny
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          Blocked in {left}s unless you allow it
        </span>
      </div>
      <div className="-mx-3 -mb-3 h-1 bg-amber-200">
        <div
          className="h-full bg-amber-500 transition-[width] duration-200"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
    </div>
  );
}

function Divider({ icon, text, title }: { icon: ReactNode; text: string; title?: string }) {
  return (
    <div
      title={title}
      className="flex items-center gap-2 self-center text-xs text-muted-foreground"
    >
      <span className="h-px w-8 bg-border" />
      <span className="inline-flex items-center gap-1">
        {icon}
        {text}
      </span>
      <span className="h-px w-8 bg-border" />
    </div>
  );
}

export function SecretCard({
  name,
  why,
  onSave,
}: {
  name: string;
  why: string;
  onSave: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="flex max-w-md flex-col gap-2 self-start rounded-xl border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRoundIcon className="size-4" /> Planner asks for {name}
      </div>
      <div className="text-sm text-muted-foreground">{why}</div>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`Paste ${name}`}
        className="rounded-md border bg-background px-2 py-1 text-sm"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!value} onClick={onSave}>
          Save secret
        </Button>
        <span className="text-xs text-muted-foreground">
          Planner gets only the name, never the value.
        </span>
      </div>
    </div>
  );
}

function SecretsPopover({ stub }: { stub: Stub }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        className="rounded-md border px-2 py-1 text-xs"
        onClick={() => setOpen(!open)}
      >
        🔑 Secrets {stub.secrets.length}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-72 rounded-lg border bg-background p-2 shadow-lg">
          <div className="px-1 pb-1 text-xs text-muted-foreground">
            Shared by all your Bots. Values are never shown.
          </div>
          {stub.secrets.map((s) => (
            <div
              key={s.name}
              className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted"
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
      )}
    </div>
  );
}
