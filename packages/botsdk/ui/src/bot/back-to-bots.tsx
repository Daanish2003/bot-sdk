import { ArrowLeftIcon } from "lucide-react";

import { useChatAdapter, useI18n } from "@botsdk/react/provider";

/**
 * The phone's way back to the Bots list (spec #1117), first in a Bot's or Room's header. Hidden from
 * 768 px up, where the sidebar shows. `data-has-back` on the wrapper (the host's `Link` takes no
 * data attributes) tells `BotsApp` the page has its own arrow, so the shell's bar is dropped
 * (Settings and Admin have no header and keep it).
 */
export function BackToBots() {
  const { Link } = useChatAdapter();
  const { t } = useI18n();
  return (
    <span data-has-back className="inline-flex shrink-0 md:hidden">
      <Link
        page={{ to: "bots" }}
        aria-label={t("bots.backToList")}
        title={t("bots.backToList")}
        className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted"
      >
        <ArrowLeftIcon className="size-5" />
      </Link>
    </span>
  );
}
