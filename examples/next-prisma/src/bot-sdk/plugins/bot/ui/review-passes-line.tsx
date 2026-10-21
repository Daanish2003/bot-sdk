import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useI18n } from "../../../core/client/react/provider";
import type { BotReview } from "../shared/review";

/**
 * A Turn's quiet "✓ N calls auto-approved" line (spec #691), which expands to each pass's summary
 * and reason. `passes` are the Turn's reviews that passed.
 */
export function ReviewPassesLine({ passes }: { passes: BotReview[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="flex flex-col gap-1 self-start text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        <Chevron className="size-3" />
        {t("bots.reviewPasses", { count: passes.length })}
      </button>
      {open && (
        <ul className="flex flex-col gap-1 border-l-2 pl-2">
          {passes.map((review) => (
            <li key={review.id} data-review={review.id} className="flex flex-col">
              <span className="text-foreground">{review.summary}</span>
              <span>{review.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
