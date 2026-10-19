// PROTOTYPE (#574) variant C, "Tray and takeover": the thread shows only one-line "finished" dividers;
// a tray of live chips above the composer is the to-do list, and a hand-off takes over the whole page.
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { CheckIcon, Loader2Icon, MonitorIcon, SendIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { FakeScreen, type Helper, helperById, time, typeLabel, useHelpers } from "./mock";
import { HelperIcon } from "./variant-a";

export const name = "Tray and takeover";

function Takeover({ helper, onClose }: { helper: Helper; onClose: () => void }) {
  const { done } = useHelpers();
  const [control, setControl] = useState(false);
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background/95 p-6 backdrop-blur">
      <div className="mb-3 flex items-center gap-2">
        <MonitorIcon className="size-5" />
        <h2 className="text-lg font-semibold">{helper.reason}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label="Close"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        {typeLabel(helper.type)} · {helper.gist}. Type passwords and codes here yourself; the Bot
        never sees them.
      </p>
      <div className="mx-auto w-full max-w-4xl">
        <FakeScreen big control={control} />
      </div>
      <div className="mx-auto mt-4 flex gap-2">
        <Button variant="outline" onClick={() => setControl(!control)}>
          {control ? "Give back control" : "Take control"}
        </Button>
        <Button
          onClick={() => {
            done(helper.id);
            onClose();
          }}
        >
          <CheckIcon /> Done, hand it back
        </Button>
      </div>
    </div>
  );
}

function Chip({ helper, onOpen }: { helper: Helper; onOpen: () => void }) {
  const { stop } = useHelpers();
  const waiting = helper.status === "waiting";
  return (
    <span
      className={cn(
        "flex max-w-72 shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
        waiting ? "border-amber-500 bg-amber-100 dark:bg-amber-900" : "bg-card",
      )}
    >
      {waiting ? <HelperIcon helper={helper} /> : <Loader2Icon className="size-3 animate-spin" />}
      <button type="button" className="truncate" onClick={onOpen} title={helper.task}>
        {waiting ? `Needs you: ${helper.reason}` : `${helper.gist} · step ${helper.steps}`}
      </button>
      <button type="button" aria-label="Stop" onClick={() => stop(helper.id)}>
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

export function VariantC({ botName }: { botName: string }) {
  const { items, helpers } = useHelpers();
  const [takeover, setTakeover] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const todo = helpers.filter((h) => h.status === "running" || h.status === "waiting");
  const peeked = peek ? helperById(helpers, peek) : null;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <h1 className="font-semibold">{botName}</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
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
          if (item.kind === "computerCard")
            return h.status === "waiting" ? (
              <Button
                key={item.id}
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => setTakeover(h.id)}
              >
                <MonitorIcon /> Open the screen
              </Button>
            ) : null;
          if (item.kind === "helperFinished")
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setPeek(peek === h.id ? null : h.id)}
                className="flex items-center gap-2 self-center text-xs text-muted-foreground"
              >
                <span className="h-px w-8 bg-border" />
                <HelperIcon helper={h} /> {h.gist} finished · {time(item.at)}
                <span className="h-px w-8 bg-border" />
              </button>
            );
          return null;
        })}
        {peeked?.report && (
          <p className="self-center rounded-lg border bg-card p-2 text-xs">{peeked.report}</p>
        )}
      </div>
      {todo.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-t px-3 pt-2">
          {todo.map((h) => (
            <Chip
              key={h.id}
              helper={h}
              onOpen={() => (h.status === "waiting" ? setTakeover(h.id) : setPeek(h.id))}
            />
          ))}
        </div>
      )}
      <form className="flex items-end gap-2 p-3 pb-16" onSubmit={(e) => e.preventDefault()}>
        <Textarea placeholder="Message" rows={1} className="max-h-40 min-h-10 resize-none" />
        <Button type="submit" size="icon" aria-label="Send">
          <SendIcon />
        </Button>
      </form>
      {takeover && (
        <Takeover helper={helperById(helpers, takeover)} onClose={() => setTakeover(null)} />
      )}
    </section>
  );
}
