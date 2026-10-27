import { Button } from "@/components/ui/button";
import type { BotCheckIn } from "@botsdk/client/bot/check-in";
import { ClockIcon } from "lucide-react";

import { useI18n } from "../../../core/client/react/provider";
import { useRefusalToast } from "./refusal-toast";
import { runTime } from "./run-divider";

/**
 * What the user can do to a Check-in: cancel it while it is pending. `actingCheckIns` holds the
 * Check-ins with a cancel in flight: each of their Cancels waits for it.
 */
export type CheckInActionHandlers = {
  onCancelCheckIn: (checkInId: string) => Promise<void>;
  actingCheckIns: ReadonlySet<string>;
};

/** The Check-in in words, as its line and the popover show it: `Check-in set for Thu 09:00: "note"`. */
export function checkInText(
  { t, locale }: Pick<ReturnType<typeof useI18n>, "t" | "locale">,
  checkIn: BotCheckIn,
) {
  return t("bots.checkInSet", { time: runTime(locale, checkIn.at), note: checkIn.note });
}

/** Cancel, for a pending Check-in only. */
export function CancelCheckIn({
  checkIn,
  onCancelCheckIn,
  actingCheckIns,
}: { checkIn: BotCheckIn } & CheckInActionHandlers) {
  const { t } = useI18n();
  const run = useRefusalToast();
  if (checkIn.state !== "pending") return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={actingCheckIns.has(checkIn.id)}
      onClick={() => run(onCancelCheckIn(checkIn.id))}
    >
      {t("bots.cancel")}
    </Button>
  );
}

/**
 * A Check-in in its Bot's Conversation, after the Turn that set it (#540): "Check-in set for <time>:
 * "<note>"" with Cancel, struck through once cancelled, marked failed when its fire failed.
 */
export function CheckInLine({
  checkIn,
  ...actions
}: { checkIn: BotCheckIn } & CheckInActionHandlers) {
  const i18n = useI18n();
  return (
    <div
      data-check-in={checkIn.id}
      data-state={checkIn.state}
      className="flex items-center gap-2 self-center text-xs text-muted-foreground"
    >
      <span className="h-px w-8 bg-border" />
      <span className="inline-flex items-center gap-1">
        <ClockIcon className="size-3" />
        <span className={checkIn.state === "cancelled" ? "line-through" : undefined}>
          {checkInText(i18n, checkIn)}
        </span>
      </span>
      {checkIn.state === "failed" ? (
        <span className="text-destructive">{i18n.t("bots.checkInFailed")}</span>
      ) : null}
      <CancelCheckIn checkIn={checkIn} {...actions} />
      <span className="h-px w-8 bg-border" />
    </div>
  );
}
