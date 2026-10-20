import { FlameIcon } from "lucide-react";

import { useI18n } from "../../../core/client/react/provider";
import type { BotWarming } from "../shared/turn";
import { costOf } from "./bot-cache-chip";

/** A call that warmed the Bot's cache (#677), as a muted line in its thread with its cost. */
export function WarmLine({ warming }: { warming: BotWarming }) {
  const { t } = useI18n();
  return (
    <p
      data-warming={warming.id}
      className="inline-flex items-center gap-1 self-center text-xs text-muted-foreground"
    >
      <FlameIcon className="size-3" />
      {t("bots.cacheWarmed", { cost: costOf(warming.costMicros) })}
    </p>
  );
}
