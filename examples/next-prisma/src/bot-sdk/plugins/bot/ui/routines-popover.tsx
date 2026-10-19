import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ClockIcon } from "lucide-react";

import { useI18n } from "../../../core/client/react/provider";
import type { BotCheckIn } from "../shared/check-in";
import { type BotRoutine, scheduleText } from "../shared/routine";
import { CancelCheckIn, type CheckInActionHandlers, checkInText } from "./check-in-line";
import {
  RoutineActions,
  type RoutineActionHandlers,
  RoutineIcon,
  WebhookUrl,
} from "./routine-card";

const stateKeys = {
  pending: "bots.routinePending",
  active: "bots.routineActive",
  paused: "bots.routineStatePaused",
} as const;

/**
 * The Bot header's "Routines N · Check-ins M" button (prototype variant A), N counting the approved
 * Routines and M the pending Check-ins. It opens a popover listing every Routine with its schedule
 * and state, and Pause / Resume and Delete, then the pending Check-ins, with Cancel. An approved
 * webhook Routine's row also has its URL, with Copy and Rotate (variant B's row).
 */
export function RoutinesPopover({
  routines,
  checkIns,
  onCancelCheckIn,
  actingCheckIns,
  webhookTokens,
  onRotate,
  ...actions
}: {
  routines: BotRoutine[];
  checkIns: BotCheckIn[];
  /** The webhook tokens approving or rotating gave on this page, by Routine. */
  webhookTokens: Record<string, string>;
  onRotate: (routineId: string) => Promise<void>;
} & CheckInActionHandlers &
  RoutineActionHandlers) {
  const i18n = useI18n();
  const { t } = i18n;
  const pending = checkIns.filter((checkIn) => checkIn.state === "pending");
  const approved = routines.filter((routine) => routine.state !== "pending").length;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <ClockIcon /> {t("bots.routinesCount", { routines: approved, checkIns: pending.length })}
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <ul aria-label={t("bots.routines")} className="flex flex-col gap-2 text-sm">
          {routines.map((routine) => (
            <li key={routine.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <RoutineIcon routine={routine} className="size-4 shrink-0" />
                <span className="font-medium">{routine.name}</span>
                <span className="text-muted-foreground">
                  {routine.schedule ? scheduleText(routine.schedule) : t("bots.onWebhook")}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {t(stateKeys[routine.state])}
                </span>
                <RoutineActions routine={routine} {...actions} />
              </div>
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
        {pending.length > 0 && (
          <ul
            aria-label={t("bots.checkIns")}
            className="mt-2 flex flex-col gap-2 border-t pt-2 text-sm"
          >
            {pending.map((checkIn) => (
              <li key={checkIn.id} className="flex items-center gap-2">
                <ClockIcon className="size-4 shrink-0" />
                <span>{checkInText(i18n, checkIn)}</span>
                <span className="ml-auto">
                  <CancelCheckIn
                    checkIn={checkIn}
                    onCancelCheckIn={onCancelCheckIn}
                    actingCheckIns={actingCheckIns}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
