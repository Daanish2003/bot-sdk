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
import { runTime } from "./run-divider";

/**
 * A Routine in its Bot's Conversation, after the Turn that created it (#538, prototype variant A):
 * pending, a card titled "Created <name> routine" with its schedule, zone and prompt, and Approve /
 * Decline; approved, a one-line divider with its next run ("<name> paused" while paused), with
 * Pause / Resume and Delete.
 */
export function RoutineCard({
  routine,
  onApprove,
  onDecline,
  ...actions
}: {
  routine: BotRoutine;
  onApprove: (routineId: string) => Promise<void>;
  onDecline: (routineId: string) => Promise<void>;
} & RoutineActionHandlers) {
  const i18n = useI18n();
  const { t } = i18n;
  const titleId = useId();
  const [busy, act] = useRoutineAction(routine.id);

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
            : routine.nextRunAt
              ? t("bots.routineApprovedNext", {
                  name: routine.name,
                  time: runTime(i18n.locale, routine.nextRunAt),
                })
              : t("bots.routineApproved", { name: routine.name })}
        </span>
        <RoutineActions routine={routine} {...actions} />
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

/** What the user can do to an approved Routine: pause, resume and delete it. */
export type RoutineActionHandlers = {
  onPause: (routineId: string) => Promise<void>;
  onResume: (routineId: string) => Promise<void>;
  onDelete: (routineId: string) => Promise<void>;
};

/** Runs one action on Routine `routineId` at a time; a refusal says why in a toast. */
function useRoutineAction(routineId: string) {
  const i18n = useI18n();
  const [busy, setBusy] = useState(false);
  const act = (action: (routineId: string) => Promise<void>) => {
    setBusy(true);
    action(routineId)
      .catch((refusal) => toast.error(serverErrorText(i18n, refusal)))
      .finally(() => setBusy(false));
  };
  return [busy, act] as const;
}

/**
 * Pause (or Resume, while paused) and Delete for an approved Routine. A pending one has none: it is
 * approved or declined on its card.
 */
export function RoutineActions({
  routine,
  onPause,
  onResume,
  onDelete,
}: { routine: BotRoutine } & RoutineActionHandlers) {
  const { t } = useI18n();
  const [busy, act] = useRoutineAction(routine.id);
  if (routine.state === "pending") return null;
  return (
    <span className="inline-flex gap-1">
      {routine.state === "active" ? (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => act(onPause)}>
          {t("bots.pause")}
        </Button>
      ) : (
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => act(onResume)}>
          {t("bots.resume")}
        </Button>
      )}
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => act(onDelete)}>
        {t("bots.delete")}
      </Button>
    </span>
  );
}
