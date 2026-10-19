// PROTOTYPE (#574) variant B, "Side panel": the thread holds only Messages; a right-hand To-do panel
// lists every Helper with its progress, and a waiting one opens its live view and Done right there.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckIcon, ChevronRightIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";

import { FakeScreen, type Helper, helperById, time, typeLabel, useHelpers } from "./mock";
import { HelperIcon, StatusChip } from "./variant-a";

export const name = "Side panel";

function Detail({ helper, onBack }: { helper: Helper; onBack: () => void }) {
  const { stop, done } = useHelpers();
  const [control, setControl] = useState(false);
  const live = helper.status === "running" || helper.status === "waiting";
  return (
    <div className="flex flex-col gap-3 text-sm">
      <button type="button" className="self-start text-xs text-muted-foreground" onClick={onBack}>
        ← To-do
      </button>
      <div className="flex items-center gap-2">
        <HelperIcon helper={helper} />
        <span className="font-medium">{helper.gist}</span>
        <span className="ml-auto">
          <StatusChip status={helper.status} />
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {typeLabel(helper.type)} · started {time(helper.startedAt)} · {helper.steps} steps
      </p>
      {helper.status === "waiting" && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-400 p-2">
          <p className="font-medium">{helper.reason}</p>
          <FakeScreen big control={control} />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => done(helper.id)}>
              <CheckIcon /> Done
            </Button>
            <Button size="sm" variant="outline" onClick={() => setControl(!control)}>
              {control ? "Give back control" : "Take control"}
            </Button>
            <Button size="sm" variant="ghost">
              Copy link
            </Button>
          </div>
        </div>
      )}
      <section>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground uppercase">Task</h3>
        <p className="text-xs">{helper.task}</p>
      </section>
      <section>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground uppercase">Latest step</h3>
        <p className="font-mono text-[11px]">{helper.latest}</p>
      </section>
      {helper.report && (
        <section>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground uppercase">Report</h3>
          <p className="text-xs">{helper.report}</p>
        </section>
      )}
      {live && (
        <Button size="sm" variant="outline" className="self-start" onClick={() => stop(helper.id)}>
          Stop this Helper
        </Button>
      )}
    </div>
  );
}

function Row({ helper, onOpen }: { helper: Helper; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border p-2 text-left text-sm hover:bg-muted",
        helper.status === "waiting" && "border-amber-400 bg-amber-50 dark:bg-amber-950",
      )}
    >
      <span className="flex items-center gap-2">
        <HelperIcon helper={helper} />
        <span className="flex-1 truncate font-medium">{helper.gist}</span>
        <StatusChip status={helper.status} />
        <ChevronRightIcon className="size-3.5 text-muted-foreground" />
      </span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">
        {helper.status === "waiting" ? helper.reason : `step ${helper.steps} · ${helper.latest}`}
      </span>
    </button>
  );
}

export function VariantB({ botName }: { botName: string }) {
  const { items, helpers, stop } = useHelpers();
  const [openId, setOpenId] = useState<string | null>(null);
  const todo = helpers.filter((h) => h.status === "running" || h.status === "waiting");
  const finished = helpers.filter((h) => !todo.includes(h));
  const open = openId ? helperById(helpers, openId) : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <h1 className="font-semibold">{botName}</h1>
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
            if (item.kind === "computerCard") {
              const h = helperById(helpers, item.helperId);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setOpenId(h.id)}
                  className="flex items-center gap-2 self-start rounded-full border px-3 py-1 text-xs"
                >
                  <MonitorIcon className="size-3.5" />
                  {h.status === "waiting"
                    ? "Open the screen in To-do →"
                    : `Screen handed back · ${h.gist}`}
                </button>
              );
            }
            return null;
          })}
        </div>
      </section>
      <aside className="flex w-96 shrink-0 flex-col gap-3 overflow-y-auto border-l p-4 pb-24">
        {open ? (
          <Detail helper={open} onBack={() => setOpenId(null)} />
        ) : (
          <>
            <div className="flex items-center">
              <h2 className="font-semibold">To-do</h2>
              {todo.length > 1 && (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => stop()}>
                  Stop all
                </Button>
              )}
            </div>
            {todo.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing in progress.</p>
            )}
            {[...todo]
              .sort((a, b) => (a.status === "waiting" ? -1 : b.status === "waiting" ? 1 : 0))
              .map((h) => (
                <Row key={h.id} helper={h} onOpen={() => setOpenId(h.id)} />
              ))}
            {finished.length > 0 && (
              <>
                <h3 className="mt-2 text-xs font-medium text-muted-foreground uppercase">
                  Finished
                </h3>
                {finished.map((h) => (
                  <Row key={h.id} helper={h} onOpen={() => setOpenId(h.id)} />
                ))}
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
