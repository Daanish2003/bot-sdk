// PROTOTYPE (#542) variant A, "In the thread": everything lives inline in the Conversation.
// Approval card after the creating Turn, run provenance as dividers, Check-ins as inline lines,
// and a header popover to manage everything.
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BellIcon, ClockIcon, WebhookIcon } from "lucide-react";
import { Fragment } from "react";

import { type Routine, scheduleText, useSchedule, viaText } from "./mock";

export const name = "In the thread";

export function VariantA({ botName }: { botName: string }) {
  const s = useSchedule();
  const live = s.routines.filter((r) => r.state !== "pending");

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <h1 className="font-semibold">{botName}</h1>
        <Popover>
          <PopoverTrigger render={<Button variant="outline" size="sm" className="ml-auto" />}>
            <ClockIcon /> Routines {live.length} · Check-ins{" "}
            {s.checkIns.filter((c) => c.state === "pending").length}
          </PopoverTrigger>
          <PopoverContent className="w-96">
            <ul className="flex flex-col gap-2 text-sm">
              {s.routines.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  {r.webhookUrl ? (
                    <WebhookIcon className="size-4" />
                  ) : (
                    <ClockIcon className="size-4" />
                  )}
                  <span className="font-medium">{r.name}</span>
                  <span className="text-muted-foreground">{scheduleText(r)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{r.state}</span>
                  <RoutineActions routine={r} />
                </li>
              ))}
              {s.checkIns
                .filter((c) => c.state === "pending")
                .map((c) => (
                  <li key={c.id} className="flex items-center gap-2">
                    <BellIcon className="size-4" />
                    <span>{c.at}</span>
                    <span className="truncate text-muted-foreground">{c.note}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => s.cancelCheckIn(c.id)}
                    >
                      Cancel
                    </Button>
                  </li>
                ))}
            </ul>
          </PopoverContent>
        </Popover>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
        {s.items.map((item) => (
          <Fragment key={item.id}>
            {item.kind === "quiet" ? (
              <Divider>
                <ClockIcon className="size-3" /> {viaText(item.via)} · ran, nothing to say
              </Divider>
            ) : (
              <>
                {item.via && (
                  <Divider>
                    {item.via.channel === "webhook" ? (
                      <WebhookIcon className="size-3" />
                    ) : (
                      <ClockIcon className="size-3" />
                    )}{" "}
                    {viaText(item.via)}
                  </Divider>
                )}
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
              </>
            )}
            {s.routines
              .filter((r) => r.createdAfter === item.id)
              .map((r) =>
                r.state === "pending" ? (
                  <ApprovalCard key={r.id} routine={r} />
                ) : (
                  <ApprovedLine key={r.id} routine={r} />
                ),
              )}
            {s.checkIns
              .filter((c) => c.setAfter === item.id)
              .map((c) => (
                <Divider key={c.id}>
                  <BellIcon className="size-3" />
                  {c.state === "cancelled" ? (
                    <s>Check-in {c.at}</s>
                  ) : (
                    <>
                      Check-in set for {c.at}: “{c.note}” ·{" "}
                      <button
                        type="button"
                        className="underline"
                        onClick={() => s.cancelCheckIn(c.id)}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </Divider>
              ))}
          </Fragment>
        ))}
      </div>
      <Composer />
    </section>
  );
}

function ApprovalCard({ routine }: { routine: Routine }) {
  const s = useSchedule();
  return (
    <Card size="sm" className="max-w-md self-start border-amber-400">
      <CardHeader>
        <CardTitle>Created {routine.name} routine</CardTitle>
        <CardDescription>
          Runs {scheduleText(routine)} ({routine.timeZone}). It won't run until you approve.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm whitespace-pre-wrap">{routine.prompt}</CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" onClick={() => s.approve(routine.id)}>
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => s.decline(routine.id)}>
          Decline
        </Button>
      </CardFooter>
    </Card>
  );
}

function ApprovedLine({ routine }: { routine: Routine }) {
  return (
    <Divider>
      <ClockIcon className="size-3" /> {routine.name}{" "}
      {routine.state === "paused" ? "paused" : `approved · next run ${routine.nextRun}`}
      <RoutineActions routine={routine} />
    </Divider>
  );
}

function RoutineActions({ routine }: { routine: Routine }) {
  const s = useSchedule();
  if (routine.state === "pending") return null;
  return (
    <span className="inline-flex gap-1">
      {routine.state === "active" ? (
        <Button size="xs" variant="ghost" onClick={() => s.pause(routine.id)}>
          Pause
        </Button>
      ) : (
        <Button size="xs" variant="ghost" onClick={() => s.resume(routine.id)}>
          Resume
        </Button>
      )}
      {routine.webhookUrl && (
        <Button size="xs" variant="ghost" onClick={() => s.rotate(routine.id)}>
          Rotate URL
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={() => s.remove(routine.id)}>
        Delete
      </Button>
    </span>
  );
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 self-center text-xs text-muted-foreground">
      <span className="h-px w-8 bg-border" />
      <span className="inline-flex items-center gap-1">{children}</span>
      <span className="h-px w-8 bg-border" />
    </div>
  );
}

export function Composer() {
  return (
    <div className="border-t p-3">
      <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
        Message (prototype: not wired)
      </div>
    </div>
  );
}
