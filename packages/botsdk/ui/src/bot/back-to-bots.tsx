import { ArrowLeftIcon } from "lucide-react";

import { useChatAdapter, useI18n } from "@botsdk/react/provider";

/**
 * The phone's way back to the Bots list (spec #1117), first in a Bot's or Room's header. Hidden from
 * 768 px up, where the sidebar shows. `data-has-back` tells `BotsApp` the page has its own arrow,
 * so the shell's bar is dropped (Settings and Admin have no header and keep it).
 */
export function BackToBots() {
  const { Link } = useChatAdapter();
  const { t } = useI18n();
  return (
    <Link
      page={{ to: "bots" }}
      data-has-back
      aria-label={t("bots.backToList")}
      title={t("bots.backToList")}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted md:hidden"
    >
      <ArrowLeftIcon className="size-5" />
    </Link>
  );
}
