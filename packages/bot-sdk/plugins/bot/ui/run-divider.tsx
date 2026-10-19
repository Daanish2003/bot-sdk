import { ClockIcon } from "lucide-react";

import { dateFormat } from "../../../core/client/intl";
import { useI18n } from "../../../core/client/react/provider";

/** A Routine run's time as its dividers show it, in the browser's zone: `Mon 08:00`. */
export function runTime(locale: string, at: Date): string {
  return dateFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(at);
}

/**
 * The divider above a Routine run's Messages (#539): "<name> · <time>", with a clock. A quiet run
 * has one of its own: "<name> · <time> · ran, nothing to say".
 */
export function RunDivider({ name, at, quiet }: { name: string; at: Date; quiet: boolean }) {
  const { t, locale } = useI18n();
  const time = runTime(locale, at);
  return (
    <div
      data-run={name}
      data-quiet={quiet || undefined}
      className="flex items-center gap-2 self-center text-xs text-muted-foreground"
    >
      <span className="h-px w-8 bg-border" />
      <span className="inline-flex items-center gap-1">
        <ClockIcon className="size-3" />
        {quiet ? t("bots.routineRanQuiet", { name, time }) : t("bots.routineRan", { name, time })}
      </span>
      <span className="h-px w-8 bg-border" />
    </div>
  );
}
