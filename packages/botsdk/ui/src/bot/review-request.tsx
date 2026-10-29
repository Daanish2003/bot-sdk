import { Button } from "@/components/ui/button";
import { approvalWaitMs, type BotReview } from "@botsdk/client/bot/review";
import { ShieldAlertIcon, ShieldCheckIcon, ShieldXIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { dateFormat } from "@botsdk/react/intl";
import { useI18n } from "@botsdk/react/provider";
import { useRefusalToast } from "./refusal-toast";

/** The call as the card shows it raw: a shell call's command, else its arguments. */
function rawCall(review: BotReview): string {
  const { command } = review.input;
  return typeof command === "string" ? command : JSON.stringify(review.input);
}

/** The time now, again every quarter second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** How a pending request's expiry reads: its day and time. */
const expiryFormat: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * A blocked call's Approval request at the call's place in the thread (spec #691, prototype
 * variant A): while it waits, an amber card with the call in plain words, the reviewer's reason,
 * the raw command, Allow and Deny, and "Blocked in Ns unless you allow it" over a bar draining for
 * 15 s. Pending past its wait (ADR 0030), the same card says "waiting · expires <date>" in place
 * of the countdown. Answered or expired, it is a one-line divider. A reviewer
 * failure is a block like any other.
 */
export function ReviewRequest({
  review,
  onAllow,
  onDeny,
  acting,
}: {
  review: BotReview;
  onAllow: (reviewId: string) => Promise<void>;
  onDeny: (reviewId: string) => Promise<void>;
  acting: boolean;
}) {
  const { t, locale } = useI18n();
  const run = useRefusalToast();
  const waiting = review.state === "waiting";
  const pending = review.state === "pending";
  const now = useNow(waiting);
  const leftMs = review.deadline ? Math.max(0, review.deadline.getTime() - now) : 0;

  // Past its deadline, a waiting card stays until the wait marks it pending or expired.
  if (!pending && !waiting) {
    const summary = review.summary;
    const [Icon, text, tone] =
      review.state === "allowed"
        ? [ShieldCheckIcon, t("bots.reviewAllowed", { summary }), "text-emerald-600"]
        : review.state === "denied"
          ? [ShieldXIcon, t("bots.reviewDenied", { summary }), "text-red-600"]
          : [ShieldXIcon, t("bots.reviewExpired", { summary }), "text-red-600"];
    return (
      <div
        data-review={review.id}
        data-state={review.state}
        title={review.reason}
        className="flex items-center gap-2 self-center text-xs text-muted-foreground"
      >
        <span className="h-px w-8 bg-border" />
        <span className="inline-flex items-center gap-1">
          <Icon className={`size-3 ${tone}`} />
          {text}
        </span>
        <span className="h-px w-8 bg-border" />
      </div>
    );
  }

  const seconds = Math.ceil(leftMs / 1000);
  const fraction = Math.min(1, leftMs / approvalWaitMs);
  return (
    <div
      data-review={review.id}
      data-state={review.state}
      className="flex max-w-md flex-col gap-2 self-start overflow-hidden rounded-xl border border-amber-400 bg-amber-50 p-3 dark:bg-amber-950/30"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlertIcon className="size-4 text-amber-600" />
        {review.summary}
      </div>
      <div className="text-sm">{review.reason}</div>
      {/* The whole command, wrapped and scrollable, so the user reads its end before Allow. */}
      <pre className="max-h-40 overflow-y-auto rounded bg-background/70 px-2 py-1 text-xs break-all whitespace-pre-wrap">
        <code>{rawCall(review)}</code>
      </pre>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={acting} onClick={() => run(onAllow(review.id))}>
          {t("bots.reviewAllow")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={acting}
          onClick={() => run(onDeny(review.id))}
        >
          {t("bots.reviewDeny")}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {pending
            ? t("bots.reviewPending", {
                expires: review.expiresAt
                  ? dateFormat(locale, expiryFormat).format(review.expiresAt)
                  : "",
              })
            : t("bots.reviewCountdown", { seconds })}
        </span>
      </div>
      {!pending && (
        <div
          role="progressbar"
          aria-label={t("bots.reviewCountdown", { seconds })}
          aria-valuemin={0}
          aria-valuemax={approvalWaitMs / 1000}
          aria-valuenow={seconds}
          className="-mx-3 -mb-3 h-1 bg-amber-200"
        >
          <div
            className="h-full bg-amber-500 transition-[width] duration-200"
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
