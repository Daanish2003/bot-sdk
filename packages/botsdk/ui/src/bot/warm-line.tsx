import type { BotWarming } from "@botsdk/client/bot/turn";
import { FlameIcon } from "lucide-react";

import { useI18n } from "@botsdk/react/provider";
import { SettledLine } from "./approval-card";
import { costOf } from "./bot-cache-chip";

/** A call that warmed the Bot's cache (#677), as a muted line in its thread with its cost. */
export function WarmLine({ warming }: { warming: BotWarming }) {
  const { t } = useI18n();
  return (
    <SettledLine data-warming={warming.id} icon={<FlameIcon className="size-3" />}>
      {t("bots.cacheWarmed", { cost: costOf(warming.costMicros) })}
    </SettledLine>
  );
}
