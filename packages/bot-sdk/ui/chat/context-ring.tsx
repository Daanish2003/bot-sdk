import type { ContextFill } from "../../plugins/assistant/client/context-ring";
import { useI18n } from "../../core/client/react/provider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const levelColor = {
  neutral: "text-muted-foreground",
  amber: "text-amber-500",
  red: "text-destructive",
} as const;

/**
 * The composer's context ring: how full the Model's window is after the last Run. Hidden when
 * there's no reading (no Run yet, or the window is unknown). Hover or focus shows the exact
 * tokens and the window.
 */
export function ContextRing({ fill }: { fill: ContextFill | null }) {
  const { t, locale } = useI18n();
  if (!fill) return null;
  const { tokens, window, percent, fraction, level } = fill;
  const summary = t("chat.contextSummary", {
    tokens: tokens.toLocaleString(locale),
    window: window.toLocaleString(locale),
    percent,
  });
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={t("chat.context", { summary })}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-full",
          levelColor[level],
        )}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 -rotate-90">
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="opacity-20"
          />
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={100}
            strokeDashoffset={100 - fraction * 100}
          />
        </svg>
      </TooltipTrigger>
      <TooltipContent>{summary}</TooltipContent>
    </Tooltip>
  );
}

/** Above the composer once the Conversation is over the selected Model's window. */
export function ContextOverflowNotice({ fill }: { fill: ContextFill | null }) {
  const { t } = useI18n();
  if (!fill?.over) return null;
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {t("chat.contextOverflow")}
    </p>
  );
}
