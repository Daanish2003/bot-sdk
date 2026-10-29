import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { EllipsisIcon, PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { useI18n } from "@botsdk/react/provider";

/**
 * The "⋯" Bot menu in a Bot's header (spec #1007): its whole-Bot actions, Pause or Resume, and Reset,
 * which opens the reset dialog.
 */
export function BotMenu({
  name,
  paused,
  acting,
  onPause,
  onResume,
  onReset,
}: {
  name: string;
  paused: boolean;
  acting: boolean;
  onPause: () => void;
  onResume: () => void;
  /** Resets the Bot with the name the user typed; resolves once it is done. */
  onReset: (name: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [resetting, setResetting] = useState(false);
  return (
    <>
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
          <DropdownMenuItem disabled={acting} onClick={() => setResetting(true)}>
            <RotateCcwIcon /> {t("bots.resetBot")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ResetBotDialog
        open={resetting}
        onOpenChange={setResetting}
        name={name}
        acting={acting}
        onReset={onReset}
      />
    </>
  );
}

/**
 * The reset dialog (spec #1007): what a reset wipes and what it keeps, and a field where the user
 * types the Bot's name. Reset is enabled only once the name matches; the dialog closes once the
 * reset is done, and stays open with the name kept when it fails.
 */
export function ResetBotDialog({
  open,
  onOpenChange,
  name,
  acting,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  acting: boolean;
  onReset: (name: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const close = () => {
    onOpenChange(false);
    setTyped("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (typed !== name || acting) return;
    void onReset(typed).then(close, () => {});
  };
  const wiped = [
    "bots.resetWipedMemory",
    "bots.resetWipedTasks",
    "bots.resetWipedHelpers",
    "bots.resetWipedApprovals",
    "bots.resetWipedHistory",
  ] as const;
  const kept = [
    "bots.resetKeptSkills",
    "bots.resetKeptShared",
    "bots.resetKeptSettings",
    "bots.resetKeptUsage",
  ] as const;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("bots.resetTitle", { name })}</DialogTitle>
          <DialogDescription>{t("bots.resetIntro")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3 text-sm">
          <section aria-label={t("bots.resetWiped")}>
            <h3 className="font-medium">{t("bots.resetWiped")}</h3>
            <ul className="list-disc pl-5 text-muted-foreground">
              {wiped.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </section>
          <section aria-label={t("bots.resetKept")}>
            <h3 className="font-medium">{t("bots.resetKept")}</h3>
            <ul className="list-disc pl-5 text-muted-foreground">
              {kept.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </section>
          <Input
            aria-label={t("bots.resetNameLabel", { name })}
            placeholder={t("bots.resetNameLabel", { name })}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("bots.cancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={typed !== name || acting}>
              {t("bots.resetConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The reset mark in a Bot's message list (spec #1007): the Bot sees nothing above it. */
export function ResetDivider() {
  const { t } = useI18n();
  return (
    <div
      data-reset-mark
      role="separator"
      aria-label={t("bots.resetDivider")}
      className="flex items-center gap-2 self-stretch text-xs text-muted-foreground"
    >
      <span className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-1">
        <RotateCcwIcon className="size-3" /> {t("bots.resetDivider")}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
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
