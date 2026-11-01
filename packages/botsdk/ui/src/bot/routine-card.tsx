import { Button } from "@/components/ui/button";
import { type BotRoutine, scheduleText } from "@botsdk/client/bot/routine";
import { ClockIcon, WebhookIcon } from "lucide-react";
import { toast } from "sonner";

import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import { ApprovalCard, SettledLine } from "./approval-card";
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
  readOnlyChanged = false,
  onApprove,
  onDecline,
  ...actions
}: {
  routine: BotRoutine;
  /** The token approving it gave on this page (ADR 0021). */
  webhookToken: string | undefined;
  /** Whether the Bot's change this Approval waits for turned read-only on or off (spec #1024). */
  readOnlyChanged?: boolean;
  onApprove: (routineId: string) => Promise<void>;
  onDecline: (routineId: string) => Promise<void>;
} & RoutineActionHandlers) {
  const i18n = useI18n();
  const { t } = i18n;
  const run = useRefusalToast();
  const busy = actions.actingRoutines.has(routine.id);

  if (routine.state !== "pending") {
    const divider = (
      <SettledLine
        data-routine={routine.name}
        data-state={routine.state}
        icon={<RoutineIcon routine={routine} className="size-3" />}
        actions={<RoutineActions routine={routine} {...actions} />}
      >
        {routine.state === "paused"
          ? t("bots.routinePaused", { name: routine.name })
          : routine.nextRunAt
            ? t("bots.routineApprovedNext", {
                name: routine.name,
                time: runTime(i18n.locale, routine.nextRunAt),
              })
            : t("bots.routineApproved", { name: routine.name })}
      </SettledLine>
    );
    if (!routine.webhook || !webhookToken) return divider;
    return (
      <>
        {divider}
        <div className="w-full">
          <WebhookUrl routineId={routine.id} token={webhookToken} />
        </div>
      </>
    );
  }

  return (
    <ApprovalCard
      data-routine={routine.name}
      data-state={routine.state}
      attention
      title={t("bots.routineCreated", { name: routine.name })}
      status={
        <>
          <div>
            {routine.schedule
              ? t("bots.routineRuns", {
                  schedule: scheduleText(routine.schedule),
                  timeZone: routine.timeZone,
                })
              : t("bots.routineRunsOnWebhook")}
          </div>
          {/* So an Approval that turns read-only on, or off, says so (spec #1024). */}
          {routine.readOnly ? (
            <div>{t("bots.routineReadOnlyNote")}</div>
          ) : (
            readOnlyChanged && <div>{t("bots.routineNoLongerReadOnly")}</div>
          )}
        </>
      }
      actions={
        <>
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
        </>
      }
    >
      <p className="whitespace-pre-wrap">{routine.prompt}</p>
    </ApprovalCard>
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
