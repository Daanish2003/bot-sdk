import type { BotSummary } from "@botsdk/client/bot/turn";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { dateFormat } from "@botsdk/react/intl";
import { useI18n } from "@botsdk/react/provider";
import { MessageMarkdown } from "./message";
import { SettledLine } from "./approval-card";

const clock: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
/** A kept Message may be days older than its Summary, so it shows its day too. */
const dayAndClock: Intl.DateTimeFormatOptions = { ...clock, weekday: "short" };

/**
 * Where the Bot's context was replaced by a Summary (#676): "Summarized while you were away · 14:10"
 * or "Summarized mid-Turn · 14:10", which expands to the Summary's text and the Messages it kept
 * word for word.
 */
export function SummaryCard({ summary }: { summary: BotSummary }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const time = (at: Date) => dateFormat(locale, clock).format(at);
  const sentAt = (at: Date) => dateFormat(locale, dayAndClock).format(at);
  const label =
    summary.kind === "away"
      ? t("bots.summaryAway", { time: time(summary.at) })
      : t("bots.summaryMidTurn", { time: time(summary.at) });
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div data-summary={summary.id} className="flex flex-col gap-2 self-stretch text-xs">
      <SettledLine icon={null}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <Chevron className="size-3" />
          {label}
        </button>
      </SettledLine>
      {open && (
        <div className="mx-auto flex w-full max-w-[80%] flex-col gap-2 rounded-lg border p-3">
          <MessageMarkdown>{summary.text}</MessageMarkdown>
          {summary.kept.length > 0 && (
            <>
              <p className="text-muted-foreground">{t("bots.summaryKept")}</p>
              {summary.kept.map((message) => (
                <blockquote key={message.id} className="flex gap-2 border-l-2 pl-2">
                  <time className="shrink-0 text-muted-foreground tabular-nums">
                    {sentAt(message.createdAt)}
                  </time>
                  <MessageMarkdown className="min-w-0 flex-1">{message.text}</MessageMarkdown>
                </blockquote>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
