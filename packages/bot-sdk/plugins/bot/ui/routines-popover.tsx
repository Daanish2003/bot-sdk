import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ClockIcon } from "lucide-react";

import { useI18n } from "../../../core/client/react/provider";
import { type BotRoutine, scheduleText } from "../shared/routine";
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
 * The Bot header's "Routines N" button (prototype variant A), N counting the approved ones. It opens
 * a popover listing every Routine with its schedule and state, and Pause / Resume and Delete. An
 * approved webhook Routine's row also has its URL, with Copy and Rotate (variant B's row).
 */
export function RoutinesPopover({
  routines,
  webhookTokens,
  onRotate,
  ...actions
}: {
  routines: BotRoutine[];
  /** The webhook tokens approving or rotating gave on this page, by Routine. */
  webhookTokens: Record<string, string>;
  onRotate: (routineId: string) => Promise<void>;
} & RoutineActionHandlers) {
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
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
