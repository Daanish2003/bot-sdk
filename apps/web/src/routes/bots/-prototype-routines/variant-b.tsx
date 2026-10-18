// PROTOTYPE (#542) variant B, "Side panel": the Conversation stays a chat; a right-hand Schedule
// panel holds approvals, Routines, Check-ins and a run log (quiet runs included).
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BellIcon, ClockIcon, CopyIcon, WebhookIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { Composer } from "./variant-a";
import { scheduleText, useSchedule, viaText } from "./mock";

export const name = "Side panel";

export function VariantB({ botName }: { botName: string }) {
  const s = useSchedule();
  const [flash, setFlash] = useState(false);
  const review = () => {
    setFlash(true);
    setTimeout(() => setFlash(false), 800);
  };
  const pending = s.routines.filter((r) => r.state === "pending");
  const live = s.routines.filter((r) => r.state !== "pending");

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="border-b px-4 py-3 font-semibold">{botName}</header>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          {s.items.map((item) =>
            item.kind === "quiet" ? null : (
              <Fragment key={item.id}>
                <div
                  className={cn(
                    "flex max-w-[70%] flex-col gap-0.5",
                    item.role === "user" ? "self-end" : "self-start",
                  )}
                >
                  {item.via && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      {item.via.channel === "webhook" ? (
                        <WebhookIcon className="size-3" />
                      ) : (
                        <ClockIcon className="size-3" />
                      )}
                      via {viaText(item.via)}
                    </span>
                  )}
                  <div
                    className={cn(
                      "rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
                      item.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
                    )}
                  >
                    {item.text}
                  </div>
                </div>
                {s.routines
                  .filter((r) => r.createdAfter === item.id)
                  .map((r) => (
                    <p key={r.id} className="self-center text-xs text-muted-foreground">
                      Created {r.name} routine
                      {r.state === "pending" ? (
                        <>
                          {" "}
                          · waiting for your OK ·{" "}
                          <button type="button" className="underline" onClick={review}>
                            Review →
                          </button>
                        </>
                      ) : (
                        ` · ${r.state}`
                      )}
                    </p>
                  ))}
              </Fragment>
            ),
          )}
        </div>
        <Composer />
      </section>

      <aside className="flex w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l p-4 text-sm">
        {pending.length > 0 && (
          <Panel title="Waiting for your OK" className={cn(flash && "ring-2 ring-amber-400")}>
            {pending.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border border-amber-400 p-3"
              >
                <div className="font-medium">{r.name}</div>
                <div className="text-xs text-muted-foreground">
                  {scheduleText(r)} · {r.timeZone}
                </div>
                <p className="whitespace-pre-wrap">{r.prompt}</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => s.approve(r.id)}>
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => s.decline(r.id)}>
                    Decline
                  </Button>
                </div>
              </div>
            ))}
          </Panel>
        )}

        <Panel title="Routines">
          {live.map((r) => (
            <div key={r.id} className="flex flex-col gap-1 border-b pb-2 last:border-0">
              <div className="flex items-center gap-2">
                {r.webhookUrl ? (
                  <WebhookIcon className="size-4" />
                ) : (
                  <ClockIcon className="size-4" />
                )}
                <span className="font-medium">{r.name}</span>
                <label className="ml-auto inline-flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={r.state === "active"}
                    onChange={() => (r.state === "active" ? s.pause(r.id) : s.resume(r.id))}
                  />
                  {r.state === "active" ? "On" : "Paused"}
                </label>
              </div>
              <div className="text-xs text-muted-foreground">
                {scheduleText(r)}
                {r.nextRun && ` · next ${r.nextRun}`}
              </div>
              {r.webhookUrl && (
                <div className="flex items-center gap-1 rounded bg-muted px-2 py-1 font-mono text-[11px]">
                  <span className="truncate">{r.webhookUrl}</span>
                  <CopyIcon className="size-3 shrink-0" />
                  <Button size="xs" variant="ghost" onClick={() => s.rotate(r.id)}>
                    Rotate
                  </Button>
                </div>
              )}
              <Button
                size="xs"
                variant="ghost"
                className="self-start text-destructive"
                onClick={() => s.remove(r.id)}
              >
                Delete
              </Button>
            </div>
          ))}
        </Panel>

        <Panel title="Check-ins">
          {s.checkIns.map((c) => (
            <div
              key={c.id}
              className={cn(
                "flex items-start gap-2",
                c.state === "cancelled" && "line-through opacity-60",
              )}
            >
              <BellIcon className="mt-0.5 size-4" />
              <div>
                <div>{c.at}</div>
                <div className="text-xs text-muted-foreground">{c.note}</div>
              </div>
              {c.state === "pending" && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => s.cancelCheckIn(c.id)}
                >
                  Cancel
                </Button>
              )}
            </div>
          ))}
        </Panel>

        <Panel title="Recent runs">
          {s.items
            .filter((i) => i.kind === "quiet" || i.via)
            .reverse()
            .map((i) => {
              const via = i.kind === "quiet" ? i.via : i.via!;
              return (
                <div key={i.id} className="flex justify-between text-xs">
                  <span>{viaText(via)}</span>
                  <span className="text-muted-foreground">
                    {i.kind === "quiet" ? "stayed quiet" : "sent a message"}
                  </span>
                </div>
              );
            })}
        </Panel>
      </aside>
    </div>
  );
}

function Panel({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-2 rounded-md transition-shadow", className)}>
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}
