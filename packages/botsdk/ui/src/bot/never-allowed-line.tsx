import type { BotReview } from "@botsdk/client/bot/review";
import { BanIcon } from "lucide-react";

import { useI18n } from "@botsdk/react/provider";

/**
 * The one-line divider for a Never-allowed review (ADR 0032): a call Auto-review blocked for good,
 * with no Approval. It reads "Never allowed · <summary>", and the reason is its tooltip.
 */
export function NeverAllowedLine({ review }: { review: BotReview }) {
  const { t } = useI18n();
  return (
    <div
      data-never-allowed={review.id}
      title={review.reason}
      className="flex items-center gap-2 self-center text-xs text-muted-foreground"
    >
      <span className="h-px w-8 bg-border" />
      <span className="inline-flex items-center gap-1">
        <BanIcon className="size-3" />
        {t("bots.neverAllowed", { summary: review.summary })}
      </span>
      <span className="h-px w-8 bg-border" />
    </div>
  );
}
