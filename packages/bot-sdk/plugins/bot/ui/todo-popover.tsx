import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { BotHelper } from "@botsdk/client/bot/helper";
import { ListTodoIcon, XIcon } from "lucide-react";

import { useI18n } from "../../../core/client/react/provider";
import { allHelpers } from "../client/react/helpers";
import { helperIcon, StatusChip } from "./helper-card";

/**
 * The Bot header's "To-do N" button (#591), N counting the Helpers still working or waiting, with a
 * dot when one needs the user. It opens a popover listing each of them (icon, gist, status chip and
 * a stop ×), with **Stop all Helpers** when there's more than one.
 */
export function TodoPopover({
  helpers,
  onStop,
  acting,
}: {
  /** The live Helpers, oldest first. */
  helpers: BotHelper[];
  /** Stops one Helper, or all of them with no id. */
  onStop: (helperId?: string) => void;
  /** The Helpers (or `allHelpers`) with a stop in flight. */
  acting: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const needsYou = helpers.some((helper) => helper.status === "waiting");
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="relative" />}>
        <ListTodoIcon /> {t("bots.todoCount", { count: helpers.length })}
        {needsYou && (
          <span
            data-needs-you
            aria-label={t("bots.helperNeedsYouDot")}
            className="absolute -top-1 -right-1 size-2.5 rounded-full bg-amber-500"
          />
        )}
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <ul aria-label={t("bots.todo")} className="flex flex-col gap-2 text-sm">
          {helpers.map((helper) => {
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
                    disabled={acting.has(helper.id) || acting.has(allHelpers)}
                    onClick={() => onStop(helper.id)}
                  >
                    <XIcon />
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
        {helpers.length > 1 && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 w-full"
            disabled={acting.has(allHelpers)}
            onClick={() => onStop()}
          >
            {t("bots.stopAllHelpers")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
