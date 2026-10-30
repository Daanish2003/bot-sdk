import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { scheduleText } from "@botsdk/client/bot/routine";
import { type BotTasks, type TaskTrigger, taskCount } from "@botsdk/client/bot/tasks";
import { ClockIcon, ListTodoIcon, PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { allHelpers } from "@botsdk/react/bot/helpers";
import { useI18n } from "@botsdk/react/provider";
import { CancelCheckIn, type CheckInActionHandlers, checkInText } from "./check-in-line";
import { helperIcon, StatusChip } from "./helper-card";
import {
  RoutineActions,
  type RoutineActionHandlers,
  RoutineIcon,
  WebhookUrl,
} from "./routine-card";
import { useRefusalToast } from "./refusal-toast";
import { runTime } from "./run-divider";
import {
  type CheckInEdit,
  CheckInEditForm,
  type RoutineEdit,
  RoutineEditForm,
} from "./task-edit-forms";

const tabs = ["inProgress", "scheduled", "done"] as const;
type Tab = (typeof tabs)[number];

const tabKeys = {
  inProgress: "bots.tasksInProgress",
  scheduled: "bots.tasksScheduled",
  done: "bots.tasksDone",
} as const;

const stateKeys = {
  pending: "bots.routinePending",
  active: "bots.routineActive",
  paused: "bots.routineStatePaused",
} as const;

const skipKeys = {
  cancelled: "bots.skipCancelled",
  paused: "bots.skipPaused",
  reset: "bots.skipReset",
  hop_limit: "bots.skipHopLimit",
} as const;

/** What skipping a waiting Trigger needs. */
export type SkipTriggerHandlers = {
  onSkipTrigger: (triggerId: string) => Promise<void>;
  actingTriggers: ReadonlySet<string>;
};

/** Skip, for a waiting Routine run, webhook call or Check-in fire; a Message or a report has none. */
function SkipTrigger({
  trigger,
  text,
  onSkipTrigger,
  actingTriggers,
}: { trigger: TaskTrigger; text: string } & SkipTriggerHandlers) {
  const { t } = useI18n();
  const run = useRefusalToast();
  if (trigger.source !== "routine" && trigger.source !== "check_in") return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      aria-label={t("bots.skipTriggerNamed", { task: text })}
      disabled={actingTriggers.has(trigger.id)}
      onClick={() => run(onSkipTrigger(trigger.id))}
    >
      {t("bots.skipTrigger")}
    </Button>
  );
}

/** A Trigger in words: a Routine's run, a webhook call, a Check-in's fire, a Helper's report. */
function useTriggerText() {
  const { t } = useI18n();
  return (trigger: TaskTrigger): string => {
    const label = trigger.label ?? "";
    if (trigger.source === "routine") {
      return t(trigger.channel === "webhook" ? "bots.taskWebhookCall" : "bots.taskRoutineRun", {
        name: label,
      });
    }
    if (trigger.source === "check_in") return t("bots.taskCheckInFire", { note: label });
    if (trigger.source === "helper") return t("bots.taskHelperReport", { gist: label });
    if (trigger.source === "approval") return t("bots.taskApprovalAnswer");
    return t("bots.taskUserMessage");
  };
}

/**
 * The Bot header's "Tasks N" button (spec #1007, prototype variant A), N counting live work: the
 * running Turn, the live Helpers and the Triggers waiting in the Conversation queue, with a dot when
 * a Helper needs the user. It opens a popover with three tabs. In progress lists the running Turn
 * (Stop) and the live Helpers (Stop). Scheduled lists the waiting Triggers, the Routines (Pause /
 * Resume, Edit, Delete, an approved webhook Routine's URL with Rotate) and the pending Check-ins
 * (Edit, Cancel), each Edit an inline form. Done lists the last 7 days' ended Helpers with their reports, fired Check-ins and
 * skipped Triggers with why. There is no create button: new Routines come from the Bot.
 */
export function TasksPopover({
  tasks,
  onStopTurn,
  onStopHelper,
  actingHelpers,
  onCancelCheckIn,
  actingCheckIns,
  webhookTokens,
  onRotate,
  onEditRoutine,
  onEditCheckIn,
  onSkipTrigger,
  actingTriggers,
  ...actions
}: {
  tasks: BotTasks;
  onStopTurn: () => void;
  /** Stops one Helper, or all of them with no id. */
  onStopHelper: (helperId?: string) => void;
  /** The Helpers (or `allHelpers`) with a stop in flight. */
  actingHelpers: ReadonlySet<string>;
  /** The webhook tokens approving or rotating gave on this page, by Routine. */
  webhookTokens: Record<string, string>;
  onRotate: (routineId: string) => Promise<void>;
  /** The user's edit of a Routine's prompt and schedule. */
  onEditRoutine: (edit: RoutineEdit) => Promise<void>;
  /** The user's edit of a pending Check-in's time and note. */
  onEditCheckIn: (edit: CheckInEdit) => Promise<void>;
} & SkipTriggerHandlers &
  CheckInActionHandlers &
  RoutineActionHandlers) {
  const i18n = useI18n();
  const { t } = i18n;
  const [tab, setTab] = useState<Tab>("inProgress");
  // The Routine or Check-in whose inline edit form is open.
  const [editing, setEditing] = useState<string | null>(null);
  const triggerText = useTriggerText();
  const { inProgress, scheduled, done } = tasks;
  const needsYou = inProgress.helpers.some((helper) => helper.status === "waiting");
  const empty = {
    inProgress: !inProgress.turn && inProgress.helpers.length === 0,
    scheduled:
      scheduled.triggers.length + scheduled.routines.length + scheduled.checkIns.length === 0,
    done: done.helpers.length + done.checkIns.length + done.skipped.length === 0,
  };
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="relative" />}>
        <ListTodoIcon /> {t("bots.tasksCount", { count: taskCount(tasks) })}
        {needsYou && (
          <span
            data-needs-you
            aria-label={t("bots.helperNeedsYouDot")}
            className="absolute -top-1 -right-1 size-2.5 rounded-full bg-amber-500"
          />
        )}
      </PopoverTrigger>
      <PopoverContent className="max-h-[70vh] w-96 overflow-y-auto">
        <div role="tablist" aria-label={t("bots.tasks")} className="mb-2 flex gap-1">
          {tabs.map((name) => (
            <Button
              key={name}
              role="tab"
              size="xs"
              variant={tab === name ? "secondary" : "ghost"}
              aria-selected={tab === name}
              onClick={() => setTab(name)}
            >
              {t(tabKeys[name])}
            </Button>
          ))}
        </div>
        <div role="tabpanel" aria-label={t(tabKeys[tab])} className="flex flex-col gap-2 text-sm">
          {empty[tab] && <p className="text-muted-foreground">{t("bots.tasksNothing")}</p>}

          {tab === "inProgress" && (
            <>
              {inProgress.turn && (
                <div data-turn className="flex items-center gap-2">
                  <span className="truncate">{t("bots.taskTurn")}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="ml-auto"
                    aria-label={t("bots.stopTurn")}
                    onClick={onStopTurn}
                  >
                    <XIcon />
                  </Button>
                </div>
              )}
              {inProgress.helpers.length > 0 && (
                <ul aria-label={t("bots.tasksInProgress")} className="flex flex-col gap-2">
                  {inProgress.helpers.map((helper) => {
                    const Icon = helperIcon(helper);
                    return (
                      <li key={helper.id} className="flex items-center gap-2">
                        <Icon className="size-4 shrink-0" />
                        <span className="truncate">{helper.gist}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          <StatusChip status={helper.status} />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("bots.stopHelper", { gist: helper.gist })}
                            disabled={actingHelpers.has(helper.id) || actingHelpers.has(allHelpers)}
                            onClick={() => onStopHelper(helper.id)}
                          >
                            <XIcon />
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {inProgress.helpers.length > 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={actingHelpers.has(allHelpers)}
                  onClick={() => onStopHelper()}
                >
                  {t("bots.stopAllHelpers")}
                </Button>
              )}
            </>
          )}

          {tab === "scheduled" && (
            <>
              {scheduled.triggers.length > 0 && (
                <ul aria-label={t("bots.tasksScheduled")} className="flex flex-col gap-2">
                  {scheduled.triggers.map((trigger) => (
                    <li key={trigger.id} className="flex items-center gap-2">
                      <ClockIcon className="size-4 shrink-0" />
                      <span className="truncate">{triggerText(trigger)}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {runTime(i18n.locale, trigger.receivedAt)}
                      </span>
                      <SkipTrigger
                        trigger={trigger}
                        text={triggerText(trigger)}
                        onSkipTrigger={onSkipTrigger}
                        actingTriggers={actingTriggers}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {scheduled.routines.length > 0 && (
                <ul aria-label={t("bots.routines")} className="flex flex-col gap-2">
                  {scheduled.routines.map((routine) => (
                    <li key={routine.id} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <RoutineIcon routine={routine} className="size-4 shrink-0" />
                        <span className="font-medium">{routine.name}</span>
                        <span className="text-muted-foreground">
                          {routine.schedule ? scheduleText(routine.schedule) : t("bots.onWebhook")}
                        </span>
                        {routine.readOnly && (
                          <span className="text-xs text-muted-foreground">
                            {t("bots.routineReadOnly")}
                          </span>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {t(stateKeys[routine.state])}
                        </span>
                        {/* A pending Routine is approved or declined on its card. */}
                        {routine.state !== "pending" && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("bots.edit", { name: routine.name })}
                            onClick={() => setEditing(editing === routine.id ? null : routine.id)}
                          >
                            <PencilIcon />
                          </Button>
                        )}
                        <RoutineActions routine={routine} {...actions} />
                      </div>
                      {editing === routine.id && routine.state !== "pending" && (
                        <RoutineEditForm
                          routine={routine}
                          onEdit={onEditRoutine}
                          onClose={() => setEditing(null)}
                          busy={actions.actingRoutines.has(routine.id)}
                        />
                      )}
                      {routine.webhook && routine.state !== "pending" && (
                        <div className="pl-6">
                          <WebhookUrl
                            routineId={routine.id}
                            token={webhookTokens[routine.id]}
                            onRotate={onRotate}
                            busy={actions.actingRoutines.has(routine.id)}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {scheduled.checkIns.length > 0 && (
                <ul aria-label={t("bots.checkIns")} className="flex flex-col gap-2">
                  {scheduled.checkIns.map((checkIn) => (
                    <li key={checkIn.id} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <ClockIcon className="size-4 shrink-0" />
                        <span>{checkInText(i18n, checkIn)}</span>
                        <span className="ml-auto inline-flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("bots.editCheckIn")}
                            onClick={() => setEditing(editing === checkIn.id ? null : checkIn.id)}
                          >
                            <PencilIcon />
                          </Button>
                          <CancelCheckIn
                            checkIn={checkIn}
                            onCancelCheckIn={onCancelCheckIn}
                            actingCheckIns={actingCheckIns}
                          />
                        </span>
                      </div>
                      {editing === checkIn.id && (
                        <CheckInEditForm
                          checkIn={checkIn}
                          onEdit={onEditCheckIn}
                          onClose={() => setEditing(null)}
                          busy={actingCheckIns.has(checkIn.id)}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === "done" && (
            <ul aria-label={t("bots.tasksDone")} className="flex flex-col gap-2">
              {done.helpers.map((helper) => {
                const Icon = helperIcon(helper);
                return (
                  <li key={helper.id} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{helper.gist}</span>
                      <span className="ml-auto shrink-0">
                        <StatusChip status={helper.status} />
                      </span>
                    </div>
                    {helper.report && (
                      <p className="pl-6 text-xs whitespace-pre-wrap text-muted-foreground">
                        {helper.report}
                      </p>
                    )}
                  </li>
                );
              })}
              {done.checkIns.map((checkIn) => (
                <li key={checkIn.id} className="flex items-center gap-2">
                  <ClockIcon className="size-4 shrink-0" />
                  <span>{checkInText(i18n, checkIn)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t("bots.checkInFired")}
                  </span>
                </li>
              ))}
              {done.skipped.map((trigger) => (
                <li key={trigger.id} className="flex items-center gap-2">
                  <ClockIcon className="size-4 shrink-0" />
                  <span className="truncate">{triggerText(trigger)}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {t("bots.taskSkipped")}: {t(skipKeys[trigger.skipReason ?? "cancelled"])}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
