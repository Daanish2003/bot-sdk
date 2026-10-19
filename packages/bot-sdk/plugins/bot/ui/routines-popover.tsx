import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ClockIcon } from "lucide-react";

import { useI18n } from "../../../core/client/react/provider";
import { type BotRoutine, scheduleText } from "../shared/routine";
import { RoutineActions, type RoutineActionHandlers } from "./routine-card";

const stateKeys = {
  pending: "bots.routinePending",
  active: "bots.routineActive",
  paused: "bots.routineStatePaused",
} as const;

/**
 * The Bot header's "Routines N" button (prototype variant A), N counting the approved ones. It opens
 * a popover listing every Routine with its schedule and state, and Pause / Resume and Delete.
 */
export function RoutinesPopover({
  routines,
  ...actions
}: { routines: BotRoutine[] } & RoutineActionHandlers) {
  const { t } = useI18n();
  const approved = routines.filter((routine) => routine.state !== "pending").length;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="ml-auto" />}>
        <ClockIcon /> {t("bots.routinesCount", { count: approved })}
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <ul aria-label={t("bots.routines")} className="flex flex-col gap-2 text-sm">
          {routines.map((routine) => (
            <li key={routine.id} className="flex items-center gap-2">
              <ClockIcon className="size-4 shrink-0" />
              <span className="font-medium">{routine.name}</span>
              {routine.schedule && (
                <span className="text-muted-foreground">{scheduleText(routine.schedule)}</span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {t(stateKeys[routine.state])}
              </span>
              <RoutineActions routine={routine} {...actions} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
