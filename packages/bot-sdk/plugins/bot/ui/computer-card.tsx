import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BotHelper, ComputerCard as Card } from "@botsdk/client/bot/helper";
import { CheckIcon, MonitorIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import { type ScreenMode, useFreshLink, useLiveView } from "../client/react/helpers";

type CardProps = {
  card: Card;
  helper: BotHelper | undefined;
  onDone: (helperId: string) => void;
  acting: boolean;
};

/**
 * A Computer-use Helper's hand-off in its Bot's Conversation (#568, slide 8), after the hand-off
 * Message: the reason as its title, a small live view of the Screen, **Done**, **Take control**,
 * **Copy link** (a fresh link) and **View details**, which shows the Helper's task. Tapping the
 * preview or Take control opens the full-screen takeover (#597). Once answered it collapses to
 * "<gist>: done" or "<gist>: cancelled".
 */
export function ComputerCard(props: CardProps) {
  const { t } = useI18n();
  const { card, helper } = props;
  if (card.state === "open") return <OpenComputerCard {...props} />;
  const gist = helper?.gist ?? card.reason;
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

function OpenComputerCard({ card, helper, onDone, acting }: CardProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const [details, setDetails] = useState(false);
  const [takeover, setTakeover] = useState<ScreenMode | null>(null);
  const freshLink = useFreshLink(card.helperId);
  const copyLink = () =>
    freshLink()
      .then((href) => navigator.clipboard.writeText(href))
      .then(() => toast.success(t("bots.linkCopied")))
      .catch((error) => toast.error(serverErrorText(i18n, error)));
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
        className="relative aspect-[16/10] w-full overflow-hidden rounded-md border bg-muted"
      >
        {/* Unmounted under the takeover, so it is one session at a time, with a fresh link after. */}
        {takeover ? (
          <LiveView url={undefined} failed={false} interactive={false} />
        ) : (
          <Preview helperId={card.helperId} />
        )}
        {/* Over the view, so a tap opens the takeover instead of reaching the Screen. */}
        <button
          type="button"
          aria-label={t("bots.screenPreview")}
          className="absolute inset-0 cursor-zoom-in"
          onClick={() => setTakeover("view")}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={acting} onClick={() => onDone(card.helperId)}>
          <CheckIcon /> {t("bots.handOffDone")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setTakeover("control")}>
          {t("bots.takeControl")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyLink()}>
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
      {takeover && (
        <Takeover
          card={card}
          startMode={takeover}
          onClose={() => setTakeover(null)}
          onDone={onDone}
          acting={acting}
        />
      )}
    </div>
  );
}

/** The card's small view-only live view, on a link of its own. */
function Preview({ helperId }: { helperId: string }) {
  const live = useLiveView(helperId);
  return <LiveView url={live.url} failed={live.failed} interactive={false} />;
}

/** A Screen's noVNC page, or a placeholder until its link comes (or says it couldn't). */
export function LiveView({
  url,
  failed,
  interactive,
}: {
  url: string | undefined;
  failed: boolean;
  interactive: boolean;
}) {
  const { t } = useI18n();
  if (url) {
    return (
      <iframe
        src={url}
        // The sandbox serves this page, so it runs in an opaque origin, never the Host's.
        sandbox="allow-scripts"
        title={t("bots.liveView")}
        tabIndex={interactive ? undefined : -1}
        className={cn("size-full border-0", !interactive && "pointer-events-none")}
      />
    );
  }
  return (
    <div className="flex size-full items-center justify-center text-muted-foreground">
      {failed ? (
        <span className="text-xs">{t("bots.liveViewFailed")}</span>
      ) : (
        <MonitorIcon className="size-6" />
      )}
    </div>
  );
}

/**
 * The full-screen takeover (#597, variant C of #574): the reason, a large live view that is
 * view-only until Take control, the note that the Bot never sees what the user types, and
 * **Done, hand it back**. Closing it, Done, or the card closing elsewhere gives control back
 * (`useLiveView` does as it unmounts), and Done on the server makes the Screen view-only too.
 */
function Takeover({
  card,
  startMode,
  onClose,
  onDone,
  acting,
}: {
  card: Card;
  startMode: ScreenMode;
  onClose: () => void;
  onDone: (helperId: string) => void;
  acting: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const live = useLiveView(card.helperId, startMode);
  const control = live.mode === "control";
  const toastError = (error: unknown) => toast.error(serverErrorText(i18n, error));
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={card.reason}
      className="fixed inset-0 z-50 flex flex-col gap-3 bg-background p-4 sm:p-6"
    >
      <div className="flex items-center gap-2">
        <MonitorIcon className="size-5 shrink-0" />
        <h2 className="font-semibold">{card.reason}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label={t("bots.closeTakeover")}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("bots.takeoverNote")}</p>
      <div className="mx-auto aspect-[16/10] max-h-[75vh] w-full max-w-5xl overflow-hidden rounded-md border bg-muted">
        <LiveView url={live.url} failed={live.failed} interactive />
      </div>
      <div className="mx-auto flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!live.url}
          onClick={() => void live.switchTo(control ? "view" : "control").catch(toastError)}
        >
          {t(control ? "bots.giveBackControl" : "bots.takeControl")}
        </Button>
        <Button
          disabled={acting}
          onClick={() => {
            onDone(card.helperId);
            onClose();
          }}
        >
          <CheckIcon /> {t("bots.handItBack")}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
