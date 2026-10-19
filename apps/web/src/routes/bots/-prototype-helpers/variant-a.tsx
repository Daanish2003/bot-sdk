// PROTOTYPE (#574) variant A, "In the thread": each Helper is an inline card where the Bot started it,
// the Computer card sits in the thread like slide 8, and the to-do list is a header popover.
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  ListTodoIcon,
  Loader2Icon,
  MonitorIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { FakeScreen, type Helper, helperById, time, typeLabel, useHelpers } from "./mock";

export const name = "In the thread";

export function StatusChip({ status }: { status: Helper["status"] }) {
  const styles: Record<Helper["status"], string> = {
    running: "bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-100",
    waiting: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100",
    complete: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100",
    error: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100",
    stopped: "bg-muted text-muted-foreground",
  };
  const label = {
    running: "Working",
    waiting: "Needs you",
    complete: "Done",
    error: "Failed",
    stopped: "Stopped",
  }[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
        styles[status],
      )}
    >
      {status === "running" && <Loader2Icon className="size-3 animate-spin" />}
      {label}
    </span>
  );
}

export function HelperIcon({ helper }: { helper: Helper }) {
  return helper.type === "general" ? (
    <TerminalIcon className="size-4" />
  ) : (
    <MonitorIcon className="size-4" />
  );
}

function HelperCard({ helper }: { helper: Helper }) {
  const { stop } = useHelpers();
  const [open, setOpen] = useState(false);
  const live = helper.status === "running" || helper.status === "waiting";
  return (
    <div className="w-[70%] self-start rounded-xl border bg-card text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <HelperIcon helper={helper} />
        <span className="font-medium">{helper.gist}</span>
        <span className="text-xs text-muted-foreground">{typeLabel(helper.type)}</span>
        <span className="ml-auto">
          <StatusChip status={helper.status} />
        </span>
      </button>
      {live && (
        <p className="truncate px-3 pb-2 font-mono text-[11px] text-muted-foreground">
          step {helper.steps} · {helper.latest}
        </p>
      )}
      {open && (
        <div className="flex flex-col gap-2 border-t px-3 py-2 text-xs">
          <p>
            <span className="text-muted-foreground">Task: </span>
            {helper.task}
          </p>
          {helper.report && (
            <p>
              <span className="text-muted-foreground">Report: </span>
              {helper.report}
            </p>
          )}
          {live && (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => stop(helper.id)}
            >
              <SquareIcon /> Stop
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function ComputerCard({ helper, wide }: { helper: Helper; wide?: boolean }) {
  const { done } = useHelpers();
  const [control, setControl] = useState(false);
  const [big, setBig] = useState(false);
  const open = helper.status === "waiting";
  return (
    <div
      className={cn(
        "self-start rounded-xl border bg-card p-3 text-sm",
        wide ? "w-full" : "w-[70%]",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <MonitorIcon className="size-4" />
        <span className="font-medium">
          {open
            ? helper.reason
            : `${helper.gist}: ${helper.status === "stopped" ? "cancelled" : "done"}`}
        </span>
      </div>
      {open ? (
        <>
          <button type="button" className="block w-full" onClick={() => setBig(!big)}>
            <FakeScreen big={big || wide} control={control} />
          </button>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => done(helper.id)}>
              <CheckIcon /> Done
            </Button>
            <Button size="sm" variant="outline" onClick={() => setControl(!control)}>
              {control ? "Give back control" : "Take control"}
            </Button>
            <Button size="sm" variant="ghost">
              Copy link
            </Button>
            <Button size="sm" variant="ghost">
              View details
            </Button>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {helper.status === "stopped"
            ? "The Bot stopped this task."
            : "You handed the screen back."}
        </p>
      )}
    </div>
  );
}

function TodoPopover() {
  const { helpers, stop } = useHelpers();
  const todo = helpers.filter((h) => h.status === "running" || h.status === "waiting");
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="ml-auto" />}>
        <ListTodoIcon /> To-do {todo.length}
        {todo.some((h) => h.status === "waiting") && (
          <span className="size-2 rounded-full bg-amber-500" />
        )}
      </PopoverTrigger>
      <PopoverContent className="w-96">
        {todo.length === 0 && <p className="text-sm text-muted-foreground">Nothing in progress.</p>}
        <ul className="flex flex-col gap-2">
          {todo.map((h) => (
            <li key={h.id} className="flex items-center gap-2 text-sm">
              <HelperIcon helper={h} />
              <span className="flex-1 truncate">{h.status === "waiting" ? h.reason : h.gist}</span>
              <StatusChip status={h.status} />
              <button type="button" aria-label="Stop" onClick={() => stop(h.id)}>
                <XIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
        {todo.length > 1 && (
          <Button size="sm" variant="outline" className="mt-3" onClick={() => stop()}>
            Stop all Helpers
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function VariantA({ botName }: { botName: string }) {
  const { items, helpers } = useHelpers();
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <h1 className="font-semibold">{botName}</h1>
        <TodoPopover />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4 pb-24">
        {items.map((item) => {
          if (item.kind === "message")
            return (
              <div
                key={item.id}
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
          const h = helperById(helpers, item.helperId);
          if (item.kind === "helperStarted") return <HelperCard key={item.id} helper={h} />;
          if (item.kind === "computerCard") return <ComputerCard key={item.id} helper={h} />;
          return (
            <p key={item.id} className="self-center text-xs text-muted-foreground">
              {typeLabel(h.type)} finished · {h.gist} · {time(item.at)}
            </p>
          );
        })}
      </div>
    </section>
  );
}
