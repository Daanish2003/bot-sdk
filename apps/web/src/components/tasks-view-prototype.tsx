/*
 * PROTOTYPE, throw away (#1006, "Shape of the Tasks view"). Three variants of one Tasks view that
 * replaces the To-do and Routines popovers on /bots/$botId, switchable via `?variant=A|B|C`.
 * Mock data in memory (useState): nothing here calls the server or changes anything real.
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import {
  BellIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  EllipsisIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MonitorIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
  WebhookIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

// ---------------------------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------------------------

const BOT_NAME = "Scout";

type Source = "turn" | "helper" | "routine" | "checkin" | "webhook";
type Section = "progress" | "scheduled" | "done";

type Live = { id: string; source: Source; title: string; detail: string; computer?: boolean };
type Queued = { id: string; source: Source; title: string; detail: string; cancel?: boolean };
type Routine = {
  id: string;
  name: string;
  schedule: string;
  webhook?: boolean;
  active: boolean;
  prompt: string;
};
type CheckIn = { id: string; note: string; when: string };
type Outcome = "complete" | "error" | "fired" | "skipped" | "stopped" | "cancelled";
type Done = {
  id: string;
  source: Source;
  title: string;
  outcome: Outcome;
  detail?: string;
  ageHours: number;
};

const seedLive: Live[] = [
  { id: "l1", source: "turn", title: "Replying to your message", detail: "started 40 s ago" },
  { id: "l2", source: "helper", title: "Compare 3 flight options", detail: "running 2 min" },
  {
    id: "l3",
    source: "helper",
    title: "Fill in the visa form",
    detail: "waiting for you",
    computer: true,
  },
];
const seedQueue: Queued[] = [
  { id: "q1", source: "routine", title: "Morning brief", detail: "Routine run", cancel: true },
  { id: "q2", source: "helper", title: "Summarise inbox", detail: "Helper report" },
  { id: "q3", source: "webhook", title: "GitHub issues", detail: "webhook call", cancel: true },
];
const seedRoutines: Routine[] = [
  {
    id: "r1",
    name: "Morning brief",
    schedule: "Weekdays 08:00",
    active: true,
    prompt: "Summarise my calendar, unread email and the weather.",
  },
  {
    id: "r2",
    name: "Weekly review",
    schedule: "Fri 17:00",
    active: false,
    prompt: "List what I finished this week and what slipped.",
  },
  {
    id: "r3",
    name: "GitHub issues",
    schedule: "webhook",
    webhook: true,
    active: true,
    prompt: "Triage the new issue and label it.",
  },
];
const seedCheckIns: CheckIn[] = [
  { id: "c1", note: "Check if the parcel shipped", when: "Tomorrow 10:00" },
];
const seedDone: Done[] = [
  {
    id: "d1",
    source: "helper",
    title: "Draft the newsletter",
    outcome: "complete",
    detail: "Drafted 420 words in 3 sections; saved to newsletter.md.",
    ageHours: 2,
  },
  { id: "d2", source: "helper", title: "Scrape prices", outcome: "error", ageHours: 5 },
  { id: "d3", source: "checkin", title: "Follow up on invoice", outcome: "fired", ageHours: 20 },
  {
    id: "d4",
    source: "routine",
    title: "Morning brief",
    outcome: "skipped",
    detail: "cancelled",
    ageHours: 50,
  },
  {
    id: "d5",
    source: "routine",
    title: "Weekly review",
    outcome: "skipped",
    detail: "Bot was paused",
    ageHours: 140,
  },
  { id: "d6", source: "helper", title: "Book the restaurant", outcome: "stopped", ageHours: 290 },
];

type EditTarget = { kind: "routine" | "checkin"; id: string } | null;

function usePrototypeState() {
  const [live, setLive] = useState(seedLive);
  const [queue, setQueue] = useState(seedQueue);
  const [routines, setRoutines] = useState(seedRoutines);
  const [checkIns, setCheckIns] = useState(seedCheckIns);
  const [done, setDone] = useState(seedDone);
  const [paused, setPaused] = useState(false);
  const [resetMark, setResetMark] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [log, setLog] = useState<string[]>([]);
  const note = (entry: string) => setLog((prev) => [entry, ...prev].slice(0, 5));
  const finish = (item: Omit<Done, "ageHours">) =>
    setDone((prev) => [{ ...item, ageHours: 0 }, ...prev]);

  return {
    live,
    queue,
    routines,
    checkIns,
    done,
    paused,
    resetMark,
    resetOpen,
    setResetOpen,
    editing,
    setEditing,
    log,
    stop: (id: string) => {
      const item = live.find((found) => found.id === id);
      if (!item) return;
      setLive((prev) => prev.filter((found) => found.id !== id));
      finish({ id: `s-${id}`, source: item.source, title: item.title, outcome: "stopped" });
      note(`Stopped "${item.title}"`);
    },
    cancelQueued: (id: string) => {
      const item = queue.find((found) => found.id === id);
      if (!item) return;
      setQueue((prev) => prev.filter((found) => found.id !== id));
      finish({
        id: `x-${id}`,
        source: item.source,
        title: item.title,
        outcome: item.source === "routine" ? "skipped" : "cancelled",
        detail: item.source === "routine" ? "cancelled" : undefined,
      });
      note(`Cancelled queued "${item.title}"`);
    },
    toggleRoutine: (id: string) => {
      setRoutines((prev) => prev.map((r) => (r.id === id ? { ...r, active: !r.active } : r)));
      note(`Toggled Routine ${id}`);
    },
    deleteRoutine: (id: string) => {
      setRoutines((prev) => prev.filter((r) => r.id !== id));
      note(`Deleted Routine ${id}`);
    },
    saveRoutine: (id: string, prompt: string, schedule?: string) => {
      setRoutines((prev) =>
        prev.map((r) => (r.id === id ? { ...r, prompt, schedule: schedule ?? r.schedule } : r)),
      );
      note(`Edited Routine ${id}`);
    },
    cancelCheckIn: (id: string) => {
      const item = checkIns.find((found) => found.id === id);
      if (!item) return;
      setCheckIns((prev) => prev.filter((found) => found.id !== id));
      finish({ id: `x-${id}`, source: "checkin", title: item.note, outcome: "cancelled" });
      note(`Cancelled Check-in "${item.note}"`);
    },
    saveCheckIn: (id: string, noteText: string, when: string) => {
      setCheckIns((prev) => prev.map((c) => (c.id === id ? { ...c, note: noteText, when } : c)));
      note(`Edited Check-in ${id}`);
    },
    setPaused: (next: boolean) => {
      setPaused(next);
      note(next ? "Paused Bot" : "Resumed Bot");
    },
    reset: () => {
      setLive([]);
      setQueue([]);
      setRoutines([]);
      setCheckIns([]);
      setDone([]);
      setPaused(false);
      setResetMark("Oct 29");
      setResetOpen(false);
      note("Reset Bot");
    },
  };
}
type State = ReturnType<typeof usePrototypeState>;

// ---------------------------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------------------------

const sourceLabel: Record<Source, string> = {
  turn: "Turn",
  helper: "Helper",
  routine: "Routine",
  checkin: "Check-in",
  webhook: "webhook",
};

function SourceIcon({ source, computer }: { source: Source; computer?: boolean }) {
  const Icon = computer
    ? MonitorIcon
    : {
        turn: MessageSquareIcon,
        helper: BotIcon,
        routine: ClockIcon,
        checkin: BellIcon,
        webhook: WebhookIcon,
      }[source];
  return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}

const outcomeStyle: Record<Outcome, string> = {
  complete: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  error: "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100",
  fired: "bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100",
  skipped: "bg-muted text-muted-foreground italic",
  stopped: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", className)}>
      {children}
    </span>
  );
}

function age(hours: number) {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function LiveActions({ state, item }: { state: State; item: Live }) {
  return (
    <Button variant="outline" size="xs" onClick={() => state.stop(item.id)}>
      <SquareIcon /> Stop
    </Button>
  );
}

function QueueActions({ state, item }: { state: State; item: Queued }) {
  if (!item.cancel) return null;
  return (
    <Button
      variant="outline"
      size="xs"
      title={item.source === "routine" ? "Skip this run" : "Cancel this call"}
      onClick={() => state.cancelQueued(item.id)}
    >
      <XIcon /> Cancel
    </Button>
  );
}

function RoutineActions({ state, routine }: { state: State; routine: Routine }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button variant="outline" size="xs" onClick={() => state.toggleRoutine(routine.id)}>
        {routine.active ? <PauseIcon /> : <PlayIcon />} {routine.active ? "Pause" : "Resume"}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Edit ${routine.name}`}
        title={routine.webhook ? "Edit prompt" : "Edit prompt and schedule"}
        onClick={() => state.setEditing({ kind: "routine", id: routine.id })}
      >
        <PencilIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Delete ${routine.name}`}
        onClick={() => state.deleteRoutine(routine.id)}
      >
        <Trash2Icon />
      </Button>
    </span>
  );
}

function CheckInActions({ state, checkIn }: { state: State; checkIn: CheckIn }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Edit time and note"
        onClick={() => state.setEditing({ kind: "checkin", id: checkIn.id })}
      >
        <PencilIcon />
      </Button>
      <Button variant="outline" size="xs" onClick={() => state.cancelCheckIn(checkIn.id)}>
        <XIcon /> Cancel
      </Button>
    </span>
  );
}

function Row({
  icon,
  title,
  sub,
  end,
}: {
  icon: ReactNode;
  title: string;
  sub?: ReactNode;
  end?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-2 py-1 text-sm">
      {icon}
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{title}</span>
        {sub && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">{end}</span>
    </li>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-xs text-muted-foreground">{children}</p>;
}

function SubHead({ children }: { children: ReactNode }) {
  return (
    <h4 className="mt-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h4>
  );
}

function InProgressList({ state }: { state: State }) {
  if (state.live.length === 0) return <Empty>Nothing running.</Empty>;
  return (
    <ul>
      {state.live.map((item) => (
        <Row
          key={item.id}
          icon={<SourceIcon source={item.source} computer={item.computer} />}
          title={item.title}
          sub={`${item.computer ? "Computer-use Helper" : sourceLabel[item.source]} · ${item.detail}`}
          end={<LiveActions state={state} item={item} />}
        />
      ))}
    </ul>
  );
}

function ScheduledList({ state }: { state: State }) {
  return (
    <div>
      <SubHead>Waiting in the queue</SubHead>
      {state.queue.length === 0 ? (
        <Empty>Queue is empty.</Empty>
      ) : (
        <ul>
          {state.queue.map((item) => (
            <Row
              key={item.id}
              icon={<SourceIcon source={item.source} />}
              title={item.title}
              sub={item.detail}
              end={<QueueActions state={state} item={item} />}
            />
          ))}
        </ul>
      )}
      <SubHead>Routines</SubHead>
      {state.routines.length === 0 ? (
        <Empty>No Routines.</Empty>
      ) : (
        <ul>
          {state.routines.map((routine) => (
            <Row
              key={routine.id}
              icon={<SourceIcon source={routine.webhook ? "webhook" : "routine"} />}
              title={routine.name}
              sub={`${routine.schedule} · ${routine.active ? "active" : "paused"}`}
              end={<RoutineActions state={state} routine={routine} />}
            />
          ))}
        </ul>
      )}
      <SubHead>Check-ins</SubHead>
      {state.checkIns.length === 0 ? (
        <Empty>No Check-ins.</Empty>
      ) : (
        <ul>
          {state.checkIns.map((checkIn) => (
            <Row
              key={checkIn.id}
              icon={<SourceIcon source="checkin" />}
              title={checkIn.note}
              sub={checkIn.when}
              end={<CheckInActions state={state} checkIn={checkIn} />}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function DoneList({ items }: { items: Done[] }) {
  if (items.length === 0) return <Empty>Nothing finished in this window.</Empty>;
  return (
    <ul>
      {items.map((item) => (
        <Row
          key={item.id}
          icon={<SourceIcon source={item.source} />}
          title={item.title}
          sub={
            <>
              {sourceLabel[item.source]} · {age(item.ageHours)}
              {item.detail && ` · ${item.detail}`}
            </>
          }
          end={<Chip className={outcomeStyle[item.outcome]}>{item.outcome}</Chip>}
        />
      ))}
    </ul>
  );
}

function scheduledCount(state: State) {
  return state.queue.length + state.routines.length + state.checkIns.length;
}

// ---------------------------------------------------------------------------------------------
// Dialogs, pause banner and reset mark (all variants)
// ---------------------------------------------------------------------------------------------

function EditDialog({ state }: { state: State }) {
  const target = state.editing;
  const routine =
    target?.kind === "routine" ? state.routines.find((r) => r.id === target.id) : undefined;
  const checkIn =
    target?.kind === "checkin" ? state.checkIns.find((c) => c.id === target.id) : undefined;
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  useEffect(() => {
    if (routine) {
      setFirst(routine.prompt);
      setSecond(routine.schedule);
    } else if (checkIn) {
      setFirst(checkIn.note);
      setSecond(checkIn.when);
    }
    // Only reseed when a new target opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);
  const close = () => state.setEditing(null);
  return (
    <Dialog open={!!(routine || checkIn)} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {routine ? `Edit ${routine.name}` : "Edit Check-in"}{" "}
            <span className="text-xs text-fuchsia-600">PROTOTYPE</span>
          </DialogTitle>
          <DialogDescription>
            {routine?.webhook
              ? "A webhook Routine runs when called; only its prompt can change."
              : routine
                ? "Change what it does and when it runs."
                : "Change when it fires and what it's for."}
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {routine ? "Prompt" : "Note"}
          <Textarea value={first} onChange={(e) => setFirst(e.target.value)} rows={3} />
        </label>
        {!routine?.webhook && (
          <label className="flex flex-col gap-1 text-xs font-medium">
            {routine ? "Schedule" : "Time"}
            <Input value={second} onChange={(e) => setSecond(e.target.value)} />
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (routine)
                state.saveRoutine(routine.id, first, routine.webhook ? undefined : second);
              if (checkIn) state.saveCheckIn(checkIn.id, first, second);
              close();
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetDialog({ state }: { state: State }) {
  const [typed, setTyped] = useState("");
  return (
    <Dialog
      open={state.resetOpen}
      onOpenChange={(open) => {
        state.setResetOpen(open);
        if (!open) setTyped("");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Reset {BOT_NAME}? <span className="text-xs text-fuchsia-600">PROTOTYPE</span>
          </DialogTitle>
          <DialogDescription>This can't be undone.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="mb-1 font-semibold text-destructive">Wiped</div>
            <ul className="list-disc pl-4 text-muted-foreground">
              <li>its Memory</li>
              <li>Routines</li>
              <li>Check-ins</li>
              <li>Helpers</li>
              <li>pending Approvals</li>
            </ul>
          </div>
          <div>
            <div className="mb-1 font-semibold">Kept</div>
            <ul className="list-disc pl-4 text-muted-foreground">
              <li>Skills</li>
              <li>its files</li>
              <li>Knowledge</li>
              <li>Custom Rules</li>
              <li>settings</li>
              <li>Channels</li>
            </ul>
          </div>
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Type <span className="font-mono">{BOT_NAME}</span> to confirm
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={BOT_NAME} />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => state.setResetOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={typed !== BOT_NAME}
            onClick={() => {
              setTyped("");
              state.reset();
            }}
          >
            <RotateCcwIcon /> Reset Bot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Covers the real composer (65 px: p-3 + a 40 px textarea + border) and sits a banner above it. */
function PausedOverlay({ state }: { state: State }) {
  if (!state.paused) return null;
  return (
    <>
      <div className="absolute inset-x-0 bottom-[65px] z-10 flex items-center gap-2 border-t border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        <PauseIcon className="size-4" /> Bot is paused. Resume to send.
        <Button size="xs" className="ml-auto" onClick={() => state.setPaused(false)}>
          <PlayIcon /> Resume
        </Button>
      </div>
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 z-10 h-[65px] cursor-not-allowed bg-background/70"
      />
    </>
  );
}

function ResetMark({ state }: { state: State }) {
  if (!state.resetMark) return null;
  return (
    <div className="pointer-events-none absolute inset-x-4 top-[72px] z-10 flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full border bg-background px-2 py-0.5">
        <RotateCcwIcon className="mr-1 inline size-3" />
        Reset · {state.resetMark}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function PauseResetButtons({ state, className }: { state: State; className?: string }) {
  return (
    <div className={cn("flex gap-2", className)}>
      <Button variant="outline" size="sm" onClick={() => state.setPaused(!state.paused)}>
        {state.paused ? <PlayIcon /> : <PauseIcon />} {state.paused ? "Resume Bot" : "Pause Bot"}
      </Button>
      <Button variant="destructive" size="sm" onClick={() => state.setResetOpen(true)}>
        <RotateCcwIcon /> Reset Bot…
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// A: Header popover
// ---------------------------------------------------------------------------------------------

function VariantAHeader({ state }: { state: State }) {
  const [tab, setTab] = useState<Section>("progress");
  const count = state.live.length + state.queue.length + state.checkIns.length;
  const needsYou = state.live.some((item) => item.computer);
  const tabs: { key: Section; label: string; n: number }[] = [
    { key: "progress", label: "In progress", n: state.live.length },
    { key: "scheduled", label: "Scheduled", n: scheduledCount(state) },
    { key: "done", label: "Done", n: state.done.filter((d) => d.ageHours <= 24).length },
  ];
  return (
    <>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" size="sm" className="relative" />}>
          <ListTodoIcon /> Tasks {count}
          {needsYou && (
            <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-amber-500" />
          )}
        </PopoverTrigger>
        <PopoverContent className="w-[26rem]" align="end">
          <div className="mb-1 text-[10px] font-semibold text-fuchsia-600">
            PROTOTYPE (#1006) · A
          </div>
          <div role="tablist" className="mb-2 flex gap-1 rounded-lg bg-muted p-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-xs",
                  tab === t.key ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
                )}
              >
                {t.label} {t.n}
              </button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {tab === "progress" && <InProgressList state={state} />}
            {tab === "scheduled" && <ScheduledList state={state} />}
            {tab === "done" && (
              <>
                <SubHead>Last 24 h</SubHead>
                <DoneList items={state.done.filter((d) => d.ageHours <= 24)} />
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="Bot menu" />}
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => state.setPaused(!state.paused)}>
            {state.paused ? <PlayIcon /> : <PauseIcon />}{" "}
            {state.paused ? "Resume Bot" : "Pause Bot"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => state.setResetOpen(true)}>
            <RotateCcwIcon /> Reset Bot…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// B: Side panel
// ---------------------------------------------------------------------------------------------

function PanelSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b px-3 py-2">
      <button
        type="button"
        className="flex w-full items-center gap-1 text-sm font-semibold"
        onClick={() => setOpen(!open)}
      >
        <ChevronDownIcon className={cn("size-4 transition-transform", !open && "-rotate-90")} />
        {title}
        <span className="ml-auto rounded-full bg-muted px-2 text-xs font-normal">{count}</span>
      </button>
      {open && <div className="mt-1">{children}</div>}
    </section>
  );
}

function VariantBPanel({ state }: { state: State }) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const week = state.done.filter((d) => d.ageHours <= 24 * 7);
  if (collapsed)
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center gap-3 border-l py-3 text-xs">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open Tasks panel"
          onClick={() => setCollapsed(false)}
        >
          <PanelRightOpenIcon />
        </Button>
        <span title="In progress" className="flex flex-col items-center">
          <PlayIcon className="size-3.5" />
          {state.live.length}
        </span>
        <span title="Scheduled" className="flex flex-col items-center">
          <ClockIcon className="size-3.5" />
          {scheduledCount(state)}
        </span>
        <span title="Done (7 days)" className="flex flex-col items-center">
          <ListTodoIcon className="size-3.5" />
          {week.length}
        </span>
      </aside>
    );
  return (
    <aside className="flex w-96 shrink-0 flex-col border-l">
      <div className="flex items-center gap-2 border-b px-3 py-3">
        <ListTodoIcon className="size-4" />
        <span className="font-semibold">Tasks</span>
        <span className="text-[10px] font-semibold text-fuchsia-600">PROTOTYPE (#1006) · B</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Collapse Tasks panel"
          onClick={() => setCollapsed(true)}
        >
          <PanelRightCloseIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelSection title="In progress" count={state.live.length}>
          <InProgressList state={state} />
        </PanelSection>
        <PanelSection title="Scheduled" count={scheduledCount(state)}>
          <ScheduledList state={state} />
        </PanelSection>
        <PanelSection title="Done · last 7 days" count={week.length}>
          <DoneList items={showAll ? week : week.slice(0, 3)} />
          {week.length > 3 && (
            <Button variant="link" size="xs" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show less" : `Show more (${week.length - 3})`}
            </Button>
          )}
        </PanelSection>
      </div>
      <PauseResetButtons state={state} className="border-t p-3" />
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------
// C: Tasks page
// ---------------------------------------------------------------------------------------------

type TableRow = {
  key: string;
  section: Section;
  source: Source;
  title: string;
  status: ReactNode;
  when: string;
  actions?: ReactNode;
};

const sectionLabel: Record<Section, string> = {
  progress: "In progress",
  scheduled: "Scheduled",
  done: "Done",
};

function tableRows(state: State): TableRow[] {
  return [
    ...state.live.map((item) => ({
      key: item.id,
      section: "progress" as const,
      source: item.source,
      title: item.computer ? `${item.title} (Computer use)` : item.title,
      status: (
        <Chip
          className={
            item.computer
              ? "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100"
              : "bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100"
          }
        >
          {item.computer ? "waiting" : "running"}
        </Chip>
      ),
      when: item.detail,
      actions: <LiveActions state={state} item={item} />,
    })),
    ...state.queue.map((item) => ({
      key: item.id,
      section: "scheduled" as const,
      source: item.source,
      title: item.title,
      status: <Chip className="bg-muted">queued</Chip>,
      when: item.detail,
      actions: <QueueActions state={state} item={item} />,
    })),
    ...state.routines.map((routine) => ({
      key: routine.id,
      section: "scheduled" as const,
      source: (routine.webhook ? "webhook" : "routine") as Source,
      title: routine.name,
      status: (
        <Chip
          className={
            routine.active
              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"
              : "bg-muted"
          }
        >
          {routine.active ? "active" : "paused"}
        </Chip>
      ),
      when: routine.schedule,
      actions: <RoutineActions state={state} routine={routine} />,
    })),
    ...state.checkIns.map((checkIn) => ({
      key: checkIn.id,
      section: "scheduled" as const,
      source: "checkin" as const,
      title: checkIn.note,
      status: <Chip className="bg-muted">pending</Chip>,
      when: checkIn.when,
      actions: <CheckInActions state={state} checkIn={checkIn} />,
    })),
    ...state.done.map((item) => ({
      key: item.id,
      section: "done" as const,
      source: item.source,
      title: item.detail ? `${item.title} — ${item.detail}` : item.title,
      status: <Chip className={outcomeStyle[item.outcome]}>{item.outcome}</Chip>,
      when: age(item.ageHours),
    })),
  ];
}

function FilterChip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs",
        on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

function VariantCPage({ state }: { state: State }) {
  const [section, setSection] = useState<Section | "all">("all");
  const [sources, setSources] = useState<Set<Source>>(new Set());
  const rows = tableRows(state).filter(
    (row) =>
      (section === "all" || row.section === section) &&
      (sources.size === 0 || sources.has(row.source)),
  );
  const toggleSource = (source: Source) =>
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="text-[10px] font-semibold text-fuchsia-600">PROTOTYPE (#1006) · C</div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">Section</span>
        {(["all", "progress", "scheduled", "done"] as const).map((key) => (
          <FilterChip key={key} on={section === key} onClick={() => setSection(key)}>
            {key === "all" ? "All" : sectionLabel[key]}
          </FilterChip>
        ))}
        <span className="ml-4 text-xs font-medium">Source</span>
        {(Object.keys(sourceLabel) as Source[]).map((source) => (
          <FilterChip key={source} on={sources.has(source)} onClick={() => toggleSource(source)}>
            {sourceLabel[source]}
          </FilterChip>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Section</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t">
                <td className="px-3 py-1.5 text-xs text-muted-foreground">
                  {sectionLabel[row.section]}
                </td>
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-1.5 text-xs">
                    <SourceIcon source={row.source} /> {sourceLabel[row.source]}
                  </span>
                </td>
                <td className="px-3 py-1.5">{row.title}</td>
                <td className="px-3 py-1.5">{row.status}</td>
                <td className="px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground">
                  {row.when}
                </td>
                <td className="px-3 py-1.5 text-right">{row.actions}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Nothing matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <section className="mt-auto rounded-lg border border-destructive/40 p-4">
        <h3 className="font-semibold text-destructive">Bot</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Pause stops new Turns, Routine runs and Check-ins until you resume. Reset wipes the Bot's
          Memory and Tasks.
        </p>
        <PauseResetButtons state={state} />
      </section>
    </div>
  );
}

function ChatTasksTabs({
  tab,
  onTab,
}: {
  tab: "chat" | "tasks";
  onTab: (t: "chat" | "tasks") => void;
}) {
  return (
    <div role="tablist" className="flex gap-4 border-b px-4">
      {(["chat", "tasks"] as const).map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => onTab(key)}
          className={cn(
            "-mb-px border-b-2 py-2 text-sm",
            tab === key ? "border-primary font-medium" : "border-transparent text-muted-foreground",
          )}
        >
          {key === "chat" ? "Chat" : "Tasks"}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Switcher and mount
// ---------------------------------------------------------------------------------------------

const variants = { A: "Header popover", B: "Side panel", C: "Tasks page" } as const;
export type PrototypeVariant = keyof typeof variants;

function Switcher({ current, log }: { current: PrototypeVariant; log: string[] }) {
  const navigate = useNavigate();
  const keys = Object.keys(variants) as PrototypeVariant[];
  const go = (step: number) => {
    const next = keys[(keys.indexOf(current) + step + keys.length) % keys.length];
    void navigate({ to: ".", search: { variant: next }, replace: true });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (process.env.NODE_ENV === "production") return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-1">
      {log[0] && (
        <div className="rounded bg-black/70 px-2 py-0.5 text-xs text-white">Last: {log[0]}</div>
      )}
      <div className="flex items-center gap-2 rounded-full bg-fuchsia-600 px-3 py-1 text-sm text-white shadow-lg">
        <button type="button" aria-label="Previous variant" onClick={() => go(-1)}>
          <ChevronLeftIcon className="size-4" />
        </button>
        PROTOTYPE #1006 · {current} ({variants[current]})
        <button type="button" aria-label="Next variant" onClick={() => go(1)}>
          <ChevronRightIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Lays out the Bot page for the chosen variant. `conversation` renders the real BotConversation,
 * with `header` added to its headerEnd (variant A's Tasks button and Bot menu).
 */
export function TasksViewPrototype({
  variant,
  conversation,
}: {
  variant: PrototypeVariant;
  conversation: (header: ReactNode) => ReactNode;
}) {
  const state = usePrototypeState();
  const [tab, setTab] = useState<"chat" | "tasks">("chat");
  const chat = (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {conversation(variant === "A" ? <VariantAHeader state={state} /> : null)}
      <ResetMark state={state} />
      <PausedOverlay state={state} />
    </div>
  );
  return (
    <>
      {variant === "A" && chat}
      {variant === "B" && (
        <div className="flex min-h-0 flex-1">
          {chat}
          <VariantBPanel state={state} />
        </div>
      )}
      {variant === "C" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <ChatTasksTabs tab={tab} onTab={setTab} />
          {tab === "chat" ? chat : <VariantCPage state={state} />}
        </div>
      )}
      <EditDialog state={state} />
      <ResetDialog state={state} />
      <Switcher current={variant} log={state.log} />
    </>
  );
}
