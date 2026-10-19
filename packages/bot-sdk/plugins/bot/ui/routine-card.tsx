import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ClockIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import { type BotRoutine, scheduleText } from "../shared/routine";

/**
 * A Routine in its Bot's Conversation, after the Turn that created it (#538, prototype variant A):
 * pending, a card titled "Created <name> routine" with its schedule, zone and prompt, and Approve /
 * Decline; approved, a one-line divider ("<name> paused" while paused).
 */
export function RoutineCard({
  routine,
  onApprove,
  onDecline,
}: {
  routine: BotRoutine;
  onApprove: (routineId: string) => Promise<void>;
  onDecline: (routineId: string) => Promise<void>;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const act = (action: (routineId: string) => Promise<void>) => {
    setBusy(true);
    action(routine.id)
      .catch((refusal) => toast.error(serverErrorText(i18n, refusal)))
      .finally(() => setBusy(false));
  };

  if (routine.state !== "pending") {
    return (
      <div
        data-routine={routine.name}
        data-state={routine.state}
        className="flex items-center gap-2 self-center text-xs text-muted-foreground"
      >
        <span className="h-px w-8 bg-border" />
        <span className="inline-flex items-center gap-1">
          <ClockIcon className="size-3" />
          {routine.state === "paused"
            ? t("bots.routinePaused", { name: routine.name })
            : t("bots.routineApproved", { name: routine.name })}
        </span>
        <span className="h-px w-8 bg-border" />
      </div>
    );
  }

  return (
    <Card
      role="group"
      aria-labelledby={titleId}
      data-routine={routine.name}
      data-state={routine.state}
      size="sm"
      className="max-w-md self-start"
    >
      <CardHeader>
        <CardTitle id={titleId}>{t("bots.routineCreated", { name: routine.name })}</CardTitle>
        {routine.schedule && (
          <CardDescription>
            {t("bots.routineRuns", {
              schedule: scheduleText(routine.schedule),
              timeZone: routine.timeZone,
            })}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="text-sm whitespace-pre-wrap">{routine.prompt}</CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" disabled={busy} onClick={() => act(onApprove)}>
          {t("bots.approve")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act(onDecline)}>
          {t("bots.decline")}
        </Button>
      </CardFooter>
    </Card>
  );
}
