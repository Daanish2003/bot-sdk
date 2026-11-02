import type { BotTurnStep } from "@botsdk/client/bot/turn";
import { useId, useState, type ReactNode } from "react";

import { useI18n } from "@botsdk/react/provider";
import { turnLineId } from "./assignment-item";
import { CacheSteps, costOf, percentOf } from "./bot-cache-chip";

/**
 * The one muted line under a Turn (spec #1117, #1124): `saved` on the left (what the Turn saved,
 * such as a Host's `afterTurn` chips) and the figures on the right (cache, Steps, cost), always
 * visible. Clicking the figures opens one panel below the line, holding each Step's cache use and
 * cost. A cache miss is amber. Its panel opens with the activity rows (#1126), then each Step.
 * Shows nothing for a Turn with no Steps and nothing saved.
 */
export function BotTurnLine({
  turnId,
  steps,
  saved,
  activity,
}: {
  /** The Turn it is under, which an Assignment's log links to. */
  turnId?: string;
  steps: BotTurnStep[];
  saved?: ReactNode;
  /** The Turn's tool activity rows (#1126), first in the panel. */
  activity?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (steps.length === 0 && !saved && !activity) return null;
  const bug = steps.find((step) => step.changed?.kind === "bug");
  const cost = costOf(steps.reduce((sum, step) => sum + step.costMicros, 0));
  const count = steps.filter((step) => step.kind !== "summary").length;
  return (
    <div
      id={turnId && turnLineId(turnId)}
      className="flex flex-col gap-1 text-xs text-muted-foreground"
    >
      <div
        data-turn-line
        role="group"
        aria-label={t("bots.turnLine")}
        className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-1">{saved}</div>
        {(steps.length > 0 || activity) && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            className={`ml-auto rounded px-1 hover:text-foreground ${bug ? "text-amber-500" : ""}`}
            onClick={() => setOpen(!open)}
          >
            {steps.length === 0
              ? t("bots.activity")
              : bug
                ? t("bots.cacheMiss", { section: bug.changed!.section, steps: count, cost })
                : t("bots.cacheChip", { percent: percentOf(steps), steps: count, cost })}
          </button>
        )}
      </div>
      {open && (
        <div id={panelId} className="flex flex-col gap-3 rounded-lg border p-2">
          {activity}
          {steps.length > 0 && <CacheSteps steps={steps} />}
        </div>
      )}
    </div>
  );
}
