import { Button } from "@/components/ui/button";
import { CheckIcon, MonitorIcon } from "lucide-react";
import { useState } from "react";

import { useI18n } from "../../../core/client/react/provider";
import type { BotHelper, ComputerCard as Card } from "../shared/helper";

/**
 * A Computer-use Helper's hand-off in its Bot's Conversation (#568, slide 8), after the hand-off
 * Message: the reason as its title, a small preview of the Screen, **Done**, **Copy link** and
 * **View details**, which shows the Helper's task. Once answered it collapses to "<gist>: done" or
 * "<gist>: cancelled". The live view behind the preview and the link come with the takeover (#597).
 */
export function ComputerCard({
  card,
  helper,
  onDone,
  acting,
}: {
  card: Card;
  helper: BotHelper | undefined;
  onDone: (helperId: string) => void;
  acting: boolean;
}) {
  const { t } = useI18n();
  const [details, setDetails] = useState(false);
  const gist = helper?.gist ?? card.reason;
  if (card.state !== "open") {
    return (
      <div
        data-computer-card
        data-state={card.state}
        className="flex w-[70%] items-center gap-2 self-start rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground"
      >
        <MonitorIcon className="size-4 shrink-0" />
        <span className="truncate">
          {t(card.state === "done" ? "bots.computerCardDone" : "bots.computerCardCancelled", {
            gist,
          })}
        </span>
      </div>
    );
  }
  return (
    <div
      data-computer-card
      data-state={card.state}
      className="flex w-[70%] flex-col gap-2 self-start rounded-xl border bg-card p-3 text-sm"
    >
      <div className="flex items-center gap-2">
        <MonitorIcon className="size-4 shrink-0" />
        <span className="font-medium">{card.reason}</span>
      </div>
      <div
        data-preview
        aria-label={t("bots.screenPreview")}
        className="flex aspect-[16/10] w-full items-center justify-center rounded-md border bg-muted text-muted-foreground"
      >
        <MonitorIcon className="size-6" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={acting} onClick={() => onDone(card.helperId)}>
          <CheckIcon /> {t("bots.handOffDone")}
        </Button>
        {/* Its fresh link comes from the live view (#597). */}
        <Button size="sm" variant="ghost" disabled>
          {t("bots.copyLink")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={details}
          onClick={() => setDetails(!details)}
        >
          {t("bots.viewDetails")}
        </Button>
      </div>
      {details && helper && (
        <p className="text-xs whitespace-pre-wrap">
          <span className="text-muted-foreground">{t("bots.helperTask")} </span>
          {helper.task}
        </p>
      )}
    </div>
  );
}
