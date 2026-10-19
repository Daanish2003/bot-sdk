import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, Loader2Icon, MonitorIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";

import { useI18n } from "../../../core/client/react/provider";
import { type BotHelper, type HelperStatus, isLiveHelper } from "../shared/helper";

const chipStyles: Record<HelperStatus, string> = {
  running: "bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-100",
  waiting: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100",
  complete: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100",
  error: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100",
  stopped: "bg-muted text-muted-foreground",
};

const chipLabels = {
  running: "bots.helperWorking",
  waiting: "bots.helperNeedsYou",
  complete: "bots.helperDone",
  error: "bots.helperFailed",
  stopped: "bots.helperStopped",
} as const;

/** A Helper's type icon: a terminal for a General Helper, a screen for a Computer-use one. */
export const helperIcon = (helper: Pick<BotHelper, "type">) =>
  helper.type === "general" ? TerminalIcon : MonitorIcon;

/** Working (with a spinner), Needs you, Done, Failed or Stopped. */
export function StatusChip({ status }: { status: HelperStatus }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
        chipStyles[status],
      )}
    >
      {status === "running" && <Loader2Icon className="size-3 animate-spin" />}
      {t(chipLabels[status])}
    </span>
  );
}

/**
 * A Helper in its Bot's Conversation, after the Bot Message of the Turn that started it (#590):
 * its type icon, the task's gist, its type and a status chip. While live it shows "step N · <latest
 * tool call>"; opening it shows the task, the report once it ended, and Stop while it's live
 * (#591). It updates in place as the Helper works and ends.
 */
export function HelperCard({
  helper,
  onStop,
  stopping,
}: {
  helper: BotHelper;
  onStop: (helperId: string) => void;
  /** Whether a stop of this Helper is in flight. */
  stopping: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const Icon = helperIcon(helper);
  return (
    <div
      data-helper={helper.id}
      data-status={helper.status}
      className="w-[70%] self-start rounded-xl border bg-card text-sm"
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <Icon className="size-4 shrink-0" />
        <span className="truncate font-medium">{helper.gist}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t(helper.type === "general" ? "bots.generalHelper" : "bots.computerUseHelper")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <StatusChip status={helper.status} />
          <ChevronDownIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {isLiveHelper(helper.status) && (
        <p className="truncate px-3 pb-2 font-mono text-[11px] text-muted-foreground">
          {helper.latest
            ? t("bots.helperStepLatest", { step: helper.steps, latest: helper.latest })
            : t("bots.helperStep", { step: helper.steps })}
        </p>
      )}
      {open && (
        <div className="flex flex-col gap-2 border-t px-3 py-2 text-xs">
          <p className="whitespace-pre-wrap">
            <span className="text-muted-foreground">{t("bots.helperTask")} </span>
            {helper.task}
          </p>
          {helper.report && (
            <p className="whitespace-pre-wrap">
              <span className="text-muted-foreground">{t("bots.helperReport")} </span>
              {helper.report}
            </p>
          )}
          {isLiveHelper(helper.status) && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={stopping}
              onClick={() => onStop(helper.id)}
            >
              {t("bots.stop")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
