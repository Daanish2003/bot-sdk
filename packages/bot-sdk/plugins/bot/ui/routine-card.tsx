import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ClockIcon, WebhookIcon } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";

import { useChatAdapter, useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import { type BotRoutine, scheduleText } from "../shared/routine";
import { useRefusalToast } from "./refusal-toast";
import { runTime } from "./run-divider";

/**
 * A Routine in its Bot's Conversation, after the Turn that created it (#538, prototype variant A):
 * pending, a card titled "Created <name> routine" with its schedule, zone and prompt, and Approve /
 * Decline; approved, a one-line divider with its next run ("<name> paused" while paused), with
 * Pause / Resume and Delete. A webhook Routine approved on this page shows its URL under it, once.
 */
export function RoutineCard({
  routine,
  webhookToken,
  onApprove,
  onDecline,
  ...actions
}: {
  routine: BotRoutine;
  /** The token approving it gave on this page (ADR 0021). */
  webhookToken: string | undefined;
  onApprove: (routineId: string) => Promise<void>;
  onDecline: (routineId: string) => Promise<void>;
} & RoutineActionHandlers) {
  const i18n = useI18n();
  const { t } = i18n;
  const titleId = useId();
  const run = useRefusalToast();
  const busy = actions.actingRoutines.has(routine.id);

  if (routine.state !== "pending") {
    const divider = (
      <div
        data-routine={routine.name}
        data-state={routine.state}
        className="flex items-center gap-2 self-center text-xs text-muted-foreground"
      >
        <span className="h-px w-8 bg-border" />
        <span className="inline-flex items-center gap-1">
          <RoutineIcon routine={routine} className="size-3" />
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
    if (!routine.webhook || !webhookToken) return divider;
    return (
      <>
        {divider}
        <div className="w-full max-w-md self-center">
          <WebhookUrl routineId={routine.id} token={webhookToken} />
        </div>
      </>
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
        <CardDescription>
          {routine.schedule
            ? t("bots.routineRuns", {
                schedule: scheduleText(routine.schedule),
                timeZone: routine.timeZone,
              })
            : t("bots.routineRunsOnWebhook")}
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm whitespace-pre-wrap">{routine.prompt}</CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" disabled={busy} onClick={() => run(onApprove(routine.id))}>
          {t("bots.approve")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => run(onDecline(routine.id))}
        >
          {t("bots.decline")}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** A Routine's icon: a webhook for a webhook Routine, a clock for a scheduled one. */
export function RoutineIcon({ routine, className }: { routine: BotRoutine; className: string }) {
  return routine.webhook ? (
    <WebhookIcon className={className} />
  ) : (
    <ClockIcon className={className} />
  );
}

/**
 * An approved webhook Routine's URL in monospace, with Copy, and Rotate when `onRotate` is given.
 * Only the token's hash is stored (ADR 0021), so the URL shows once, after approving or rotating
 * on this page; otherwise Rotate gives a new one. `busy` is true while an action on the Routine runs.
 */
export function WebhookUrl({
  routineId,
  token,
  onRotate,
  busy = false,
}: {
  routineId: string;
  token: string | undefined;
  onRotate?: (routineId: string) => Promise<void>;
  busy?: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const run = useRefusalToast();
  const { routineWebhookUrl } = useChatAdapter();
  const url = token && `${new URL(routineWebhookUrl, window.location.origin).href}/${token}`;
  const copy = (text: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t("bots.copied")))
      .catch((error) => toast.error(serverErrorText(i18n, error)));
  return (
    <div className="flex items-center gap-1 text-xs">
      {url ? (
        <span className="min-w-0 truncate font-mono">{url}</span>
      ) : (
        <span className="text-muted-foreground">{t("bots.webhookUrlHidden")}</span>
      )}
      <span className="ml-auto inline-flex shrink-0 gap-1">
        {url && (
          <Button size="xs" variant="ghost" onClick={() => void copy(url)}>
            {t("bots.copy")}
          </Button>
        )}
        {onRotate && (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => run(onRotate(routineId))}
          >
            {t("bots.rotate")}
          </Button>
        )}
      </span>
    </div>
  );
}

/**
 * What the user can do to an approved Routine: pause, resume and delete it. `actingRoutines` holds the
 * Routines with an action in flight: each of their controls waits for it.
 */
export type RoutineActionHandlers = {
  onPause: (routineId: string) => Promise<void>;
  onResume: (routineId: string) => Promise<void>;
  onDelete: (routineId: string) => Promise<void>;
  actingRoutines: ReadonlySet<string>;
};

/**
 * Pause (or Resume, while paused) and Delete for an approved Routine, each labelled with its name.
 * A pending one has none: it is approved or declined on its card.
 */
export function RoutineActions({
  routine,
  onPause,
  onResume,
  onDelete,
  actingRoutines,
}: { routine: BotRoutine } & RoutineActionHandlers) {
  const { t } = useI18n();
  const run = useRefusalToast();
  if (routine.state === "pending") return null;
  const busy = actingRoutines.has(routine.id);
  const { name } = routine;
  return (
    <span className="inline-flex gap-1">
      {routine.state === "active" ? (
        <Button
          size="xs"
          variant="ghost"
          aria-label={t("bots.pauseRoutine", { name })}
          disabled={busy}
          onClick={() => run(onPause(routine.id))}
        >
          {t("bots.pause")}
        </Button>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          aria-label={t("bots.resumeRoutine", { name })}
          disabled={busy}
          onClick={() => run(onResume(routine.id))}
        >
          {t("bots.resume")}
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost"
        aria-label={t("bots.deleteRoutine", { name })}
        disabled={busy}
        onClick={() => run(onDelete(routine.id))}
      >
        {t("bots.delete")}
      </Button>
    </span>
  );
}
