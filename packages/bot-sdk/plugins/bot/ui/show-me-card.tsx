import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type DemonstrationAction,
  type DemonstrationCard,
  type DemonstrationStep,
  isLiveDemonstration,
} from "@botsdk/client/bot/demonstration";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../../core/client/react/provider";
import { useDemonstrationSteps, useDemonstrationView } from "../client/react/demonstrations";
import { LiveView } from "./computer-card";

type Props = {
  card: DemonstrationCard;
  /** The Bot's name, which the privacy line and the red bar name as the one watching. */
  botName: string;
  onAct: (demonstrationId: string, action: DemonstrationAction) => void;
  acting: boolean;
};

const endedStatus = {
  drafting: "bots.showMeDrafting",
  saved: "bots.showMeSaved",
  cancelled: "bots.showMeCancelled",
  failed: "bots.showMeFailed",
} as const;

/**
 * A Demonstration's Show me card (spec #713, variant A of #711), which `watch_user` posts: while it
 * records or is paused, a red-bordered card with the goal, the recording dot and timer, a small
 * live view of the Screen, the privacy line, Pause or Resume, Cancel and Done, and Full screen,
 * which opens the Screen big under a red bar. Once it ends it closes to a one-line divider:
 * "Show me · N steps · <status>".
 */
export function ShowMeCard(props: Props) {
  const { t } = useI18n();
  const { card } = props;
  if (isLiveDemonstration(card.state)) return <LiveShowMeCard {...props} />;
  const status = t(endedStatus[card.state as keyof typeof endedStatus]);
  return (
    <div
      data-show-me
      data-state={card.state}
      className="flex items-center gap-2 self-center text-xs text-muted-foreground"
    >
      <span className="h-px w-12 bg-border" />
      {t("bots.showMeDivider", { steps: card.steps, status })}
      <span className="h-px w-12 bg-border" />
    </div>
  );
}

function LiveShowMeCard({ card, botName, onAct, acting }: Props) {
  const { t } = useI18n();
  const [full, setFull] = useState(false);
  const paused = card.state === "paused";
  const elapsed = useElapsed(card.startedAt);
  const steps = useDemonstrationSteps(card.demonstrationId, card.steps, card.state);
  const controls = (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={acting}
        onClick={() => onAct(card.demonstrationId, paused ? "resume" : "pause")}
      >
        {t(paused ? "bots.showMeResume" : "bots.showMePause")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={acting}
        onClick={() => onAct(card.demonstrationId, "cancel")}
      >
        {t("bots.showMeCancel")}
      </Button>
      <Button size="sm" disabled={acting} onClick={() => onAct(card.demonstrationId, "done")}>
        {t("bots.showMeDone")}
      </Button>
    </div>
  );
  return (
    <div
      data-show-me
      data-state={card.state}
      className="flex w-[70%] flex-col gap-2 self-start rounded-xl border-2 border-red-500 bg-card p-3 text-sm"
    >
      <div className="flex items-center gap-2 font-medium">
        <RecDot paused={paused} />
        <span>{t("bots.showMeTitle", { goal: card.goal })}</span>
        <span data-timer className="ml-auto font-mono text-xs text-muted-foreground">
          {elapsed}
        </span>
      </div>
      <div
        data-preview
        className="relative aspect-[16/10] w-full overflow-hidden rounded-md border bg-muted"
      >
        {/* Unmounted under full screen, so it is one session at a time, with a fresh link after. */}
        {full ? (
          <LiveView url={undefined} failed={false} interactive={false} />
        ) : (
          <Preview card={card} />
        )}
        <button
          type="button"
          aria-label={t("bots.screenPreview")}
          className="absolute inset-0 cursor-zoom-in"
          onClick={() => setFull(true)}
        />
      </div>
      {steps.length > 0 && <StepList steps={steps.slice(-3)} />}
      <p className="text-xs text-muted-foreground">
        {paused ? t("bots.showMePausedNote") : t("bots.showMeWatching", { name: botName })}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="link" className="px-0" onClick={() => setFull(true)}>
          {t("bots.showMeFullScreen")}
        </Button>
        <div className="ml-auto">{controls}</div>
      </div>
      {full && (
        <FullScreen
          card={card}
          botName={botName}
          elapsed={elapsed}
          steps={steps}
          controls={controls}
          onShrink={() => setFull(false)}
        />
      )}
    </div>
  );
}

/** The red dot that pulses while recording, amber while paused. */
function RecDot({ paused }: { paused: boolean }) {
  const { t } = useI18n();
  return (
    <span
      role="img"
      aria-label={t(paused ? "bots.showMePaused" : "bots.showMeRecording")}
      className={cn(
        "size-2 shrink-0 rounded-full",
        paused ? "bg-amber-500" : "animate-pulse bg-red-500",
      )}
    />
  );
}

/** Minutes and seconds since `startedAt`, ticking each second. */
function useElapsed(startedAt: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The card's small live view, on a link of its own. */
function Preview({ card }: { card: DemonstrationCard }) {
  const live = useDemonstrationView(card.demonstrationId);
  return <LiveView url={live.url} failed={live.failed} interactive={false} />;
}

/**
 * The Screen full screen, for the user to drive: a red bar saying whether the Bot sees what they do
 * (recording) or nothing (paused), with the timer and Shrink, the large live view, and the card's
 * controls.
 */
function FullScreen({
  card,
  botName,
  elapsed,
  steps,
  controls,
  onShrink,
}: {
  card: DemonstrationCard;
  botName: string;
  elapsed: string;
  steps: DemonstrationStep[];
  controls: ReactNode;
  onShrink: () => void;
}) {
  const { t } = useI18n();
  const live = useDemonstrationView(card.demonstrationId);
  const paused = card.state === "paused";
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("bots.showMeTitle", { goal: card.goal })}
      className="fixed inset-0 z-50 flex flex-col gap-2 bg-black/90 p-4"
    >
      <div
        data-red-bar
        className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-sm text-white"
      >
        <RecDot paused={paused} />
        <span>
          {paused ? t("bots.showMePausedBar") : t("bots.showMeRecordingBar", { name: botName })}
        </span>
        <span className="ml-auto font-mono">{elapsed}</span>
        <Button size="sm" variant="secondary" onClick={onShrink}>
          {t("bots.showMeShrink")}
        </Button>
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 gap-3">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md bg-muted">
          <LiveView url={live.url} failed={live.failed} interactive />
        </div>
        <section className="flex w-72 shrink-0 flex-col gap-2 overflow-auto rounded-md bg-card p-3">
          <h2 className="text-sm font-medium">{t("bots.showMeSteps", { name: botName })}</h2>
          {steps.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("bots.showMeNoSteps")}</p>
          ) : (
            <StepList steps={steps} label={t("bots.showMeSteps", { name: botName })} />
          )}
        </section>
      </div>
      <div className="flex justify-end">{controls}</div>
    </div>,
    document.body,
  );
}

const kindText = {
  click: "bots.showMeStepClick",
  input: "bots.showMeStepInput",
  change: "bots.showMeStepChange",
  key: "bots.showMeStepKey",
  navigation: "bots.showMeStepNavigation",
} as const;

/** `m:ss` from the start of the Demonstration. */
const offsetText = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** A page's host and path, which a navigation step names. */
const pageText = (url: string | null) => {
  if (!url) return "";
  try {
    const { host, pathname } = new URL(url);
    return ` ${host}${pathname === "/" ? "" : pathname}`;
  } catch {
    return ` ${url}`;
  }
};

/**
 * Captured steps (#719): each one's time, what was done and to what, with the value typed, chosen
 * or pressed (a password's masked, as it was captured), and a pause as the gap.
 */
function StepList({ steps, label }: { steps: DemonstrationStep[]; label?: string }) {
  const { t } = useI18n();
  return (
    <ol aria-label={label} className="flex flex-col gap-0.5 text-xs">
      {steps.map((step) =>
        step.kind === "pause" ? (
          <li
            key={step.sequence}
            data-step
            data-gap
            className="flex gap-2 border-y border-dashed py-0.5 text-muted-foreground"
          >
            <span className="w-9 shrink-0 font-mono">{offsetText(step.offsetMs)}</span>
            <span className="italic">{t("bots.showMeGap")}</span>
          </li>
        ) : (
          <li key={step.sequence} data-step className="flex gap-2">
            <span className="w-9 shrink-0 font-mono text-muted-foreground">
              {offsetText(step.offsetMs)}
            </span>
            <span className="w-12 shrink-0 text-muted-foreground">{t(kindText[step.kind])}</span>
            <span className="min-w-0 break-words">
              {step.label ? `“${step.label}”` : ""}
              {step.kind === "navigation"
                ? pageText(step.url)
                : step.value !== null && step.kind !== "click"
                  ? ` = ${step.value}`
                  : ""}
            </span>
          </li>
        ),
      )}
    </ol>
  );
}
