import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EllipsisIcon, PauseIcon, PlayIcon } from "lucide-react";

import { useI18n } from "@botsdk/react/provider";

/** The "⋯" Bot menu in a Bot's header (spec #1007): its whole-Bot actions, Pause or Resume. */
export function BotMenu({
  paused,
  acting,
  onPause,
  onResume,
}: {
  paused: boolean;
  acting: boolean;
  onPause: () => void;
  onResume: () => void;
}) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={t("bots.botMenu")} />}
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={acting} onClick={paused ? onResume : onPause}>
          {paused ? <PlayIcon /> : <PauseIcon />} {t(paused ? "bots.resumeBot" : "bots.pauseBot")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The "Paused" badge next to a paused Bot's name (spec #1007). */
export function PausedBadge() {
  const { t } = useI18n();
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      {t("bots.botPaused")}
    </span>
  );
}

/** The banner above a paused Bot's composer (spec #1007), with Resume. */
export function PausedBanner({ acting, onResume }: { acting: boolean; onResume: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 border-t border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <PauseIcon className="size-4" /> {t("bots.botPausedBanner")}
      <Button size="xs" className="ml-auto" disabled={acting} onClick={onResume}>
        <PlayIcon /> {t("bots.resume")}
      </Button>
    </div>
  );
}
