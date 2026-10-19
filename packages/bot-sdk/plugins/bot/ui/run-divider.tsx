import { ClockIcon, WebhookIcon } from "lucide-react";

import { dateFormat } from "../../../core/client/intl";
import { useI18n } from "../../../core/client/react/provider";

/** A run's time as its dividers show it, in the browser's zone: `Mon 08:00`. */
export function runTime(locale: string, at: Date): string {
  return dateFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(at);
}

/**
 * The divider above a Routine run's or fired Check-in's Messages (#539, #540): "<name> · <time>",
 * with a clock, or a webhook icon for a run a webhook started. A quiet run has one of its own:
 * "<name> · <time> · ran, nothing to say".
 */
export function RunDivider({
  name,
  at,
  quiet,
  webhook,
}: {
  name: string;
  at: Date;
  quiet: boolean;
  webhook: boolean;
}) {
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
        {webhook ? <WebhookIcon className="size-3" /> : <ClockIcon className="size-3" />}
        {quiet ? t("bots.routineRanQuiet", { name, time }) : t("bots.routineRan", { name, time })}
      </span>
      <span className="h-px w-8 bg-border" />
    </div>
  );
}
