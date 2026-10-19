import { Button } from "@/components/ui/button";
import { ClockIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import type { BotCheckIn } from "../shared/check-in";
import { runTime } from "./run-divider";

/** What the user can do to a Check-in: cancel it while it is pending. */
export type CheckInActionHandlers = { onCancelCheckIn: (checkInId: string) => Promise<void> };

/** Cancels Check-in `checkInId`; a refusal says why in a toast. */
function useCancel(checkInId: string, onCancel: (checkInId: string) => Promise<void>) {
  const i18n = useI18n();
  const [busy, setBusy] = useState(false);
  const cancel = () => {
    setBusy(true);
    onCancel(checkInId)
      .catch((refusal) => toast.error(serverErrorText(i18n, refusal)))
      .finally(() => setBusy(false));
  };
  return [busy, cancel] as const;
}

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
}: { checkIn: BotCheckIn } & CheckInActionHandlers) {
  const { t } = useI18n();
  const [busy, cancel] = useCancel(checkIn.id, onCancelCheckIn);
  if (checkIn.state !== "pending") return null;
  return (
    <Button size="xs" variant="ghost" disabled={busy} onClick={cancel}>
      {t("bots.cancel")}
    </Button>
  );
}

/**
 * A Check-in in its Bot's Conversation, after the Turn that set it (#540): "Check-in set for <time>:
 * "<note>"" with Cancel, struck through once cancelled.
 */
export function CheckInLine({
  checkIn,
  onCancelCheckIn,
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
      <CancelCheckIn checkIn={checkIn} onCancelCheckIn={onCancelCheckIn} />
      <span className="h-px w-8 bg-border" />
    </div>
  );
}
