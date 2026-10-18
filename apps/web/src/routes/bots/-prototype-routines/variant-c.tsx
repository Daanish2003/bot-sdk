// PROTOTYPE (#542) variant C, "Chat | Schedule tabs": the chat shows Routine runs as collapsible
// blocks and a sticky approval banner above the composer; a Schedule tab is a 7-day agenda.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BellIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, WebhookIcon } from "lucide-react";
import { useState } from "react";

import { Composer } from "./variant-a";
import { type Routine, scheduleText, useSchedule, viaText } from "./mock";

export const name = "Chat | Schedule tabs";

const week = [
  "Wed 21 Oct",
  "Thu 22 Oct",
  "Fri 23 Oct",
  "Sat 24 Oct",
  "Sun 25 Oct",
  "Mon 26 Oct",
  "Tue 27 Oct",
];

export function VariantC({ botName }: { botName: string }) {
  const s = useSchedule();
  const [tab, setTab] = useState<"chat" | "schedule">("chat");
  const pending = s.routines.filter((r) => r.state === "pending");

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-4 border-b px-4 pt-3">
        <h1 className="pb-3 font-semibold">{botName}</h1>
        {(["chat", "schedule"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "border-b-2 pb-3 text-sm capitalize",
              tab === t
                ? "border-foreground font-medium"
                : "border-transparent text-muted-foreground",
            )}
          >
            {t}
            {t === "schedule" && pending.length > 0 && (
              <span className="ml-1 rounded-full bg-amber-400 px-1.5 text-xs text-black">
                {pending.length}
              </span>
            )}
          </button>
        ))}
      </header>

      {tab === "chat" ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
            {s.items.map((item) => {
              if (item.kind === "quiet") return null;
              const bubble = (
                <div
                  className={cn(
                    "max-w-[70%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
                    item.role === "user"
                      ? "self-end bg-primary text-primary-foreground"
                      : "self-start bg-muted",
                  )}
                >
                  {item.text}
                </div>
              );
              return item.via ? (
                <RunBlock
                  key={item.id}
                  title={viaText(item.via)}
                  webhook={item.via.channel === "webhook"}
                >
                  {bubble}
                </RunBlock>
              ) : (
                <div key={item.id} className="flex flex-col">
                  {bubble}
                </div>
              );
            })}
          </div>
          {pending.map((r) => (
            <ApprovalBanner key={r.id} routine={r} />
          ))}
          <Composer />
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 text-sm">
          {pending.map((r) => (
            <ApprovalBanner key={r.id} routine={r} />
          ))}
          <div className="flex flex-col">
            {week.map((day, index) => {
              const weekday = index < 3 || index > 4;
              const fires = s.routines.filter(
                (r) => r.state === "active" && r.days === "weekdays" && weekday,
              );
              const checks = s.checkIns.filter(
                (c) => c.state === "pending" && c.at.startsWith(day),
              );
              return (
                <div key={day} className="grid grid-cols-[7rem_1fr] gap-3 border-b py-2">
                  <div className="font-medium">{day}</div>
                  <div className="flex flex-col gap-1">
                    {fires.length === 0 && checks.length === 0 && (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {fires.map((r) => (
                      <div key={r.id} className="flex items-center gap-2">
                        <ClockIcon className="size-4" /> {r.at}{" "}
                        <span className="font-medium">{r.name}</span>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="ml-auto"
                          onClick={() => s.pause(r.id)}
                        >
                          Pause
                        </Button>
                      </div>
                    ))}
                    {checks.map((c) => (
                      <div key={c.id} className="flex items-center gap-2">
                        <BellIcon className="size-4" /> {c.at.slice(-5)} Check-in: {c.note}
                        <Button
                          size="xs"
                          variant="ghost"
                          className="ml-auto"
                          onClick={() => s.cancelCheckIn(c.id)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase">On webhook</h2>
            {s.routines
              .filter((r) => r.webhookUrl && r.state !== "pending")
              .map((r) => (
                <div key={r.id} className="flex items-center gap-2">
                  <WebhookIcon className="size-4" /> <span className="font-medium">{r.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {r.webhookUrl}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => s.rotate(r.id)}
                  >
                    Rotate
                  </Button>
                </div>
              ))}
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase">Paused</h2>
            {s.routines
              .filter((r) => r.state === "paused")
              .map((r) => (
                <div key={r.id} className="flex items-center gap-2">
                  <span className="font-medium">{r.name}</span> {scheduleText(r)}
                  <Button
                    size="xs"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => s.resume(r.id)}
                  >
                    Resume
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => s.remove(r.id)}>
                    Delete
                  </Button>
                </div>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

function RunBlock({
  title,
  webhook,
  children,
}: {
  title: string;
  webhook: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 border-l-2 border-violet-400 pl-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      >
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        {webhook ? <WebhookIcon className="size-3" /> : <ClockIcon className="size-3" />} {title}{" "}
        ran
      </button>
      {open && <div className="flex flex-col">{children}</div>}
    </div>
  );
}

function ApprovalBanner({ routine }: { routine: Routine }) {
  const s = useSchedule();
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-3 mb-2 rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
      <div className="flex items-center gap-2">
        <ClockIcon className="size-4" />
        <span>
          <b>{routine.name}</b> wants to run {scheduleText(routine)} ({routine.timeZone})
        </span>
        <button type="button" className="text-xs underline" onClick={() => setOpen(!open)}>
          {open ? "Hide prompt" : "Show prompt"}
        </button>
        <Button size="sm" className="ml-auto" onClick={() => s.approve(routine.id)}>
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => s.decline(routine.id)}>
          Decline
        </Button>
      </div>
      {open && <p className="mt-2 whitespace-pre-wrap">{routine.prompt}</p>}
    </div>
  );
}
