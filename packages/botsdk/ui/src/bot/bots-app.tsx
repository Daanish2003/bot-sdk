import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { BotSidebar } from "./bot-sidebar";

/**
 * The full-screen Bots app, in place of the assistant's shell: the Bots sidebar, then the page.
 * Below 768 px it shows one screen at a time (spec #1117): the list while `BotsHomePage` is the
 * page, otherwise the page at full width under a back arrow to the list. The URL chooses, so no
 * drawer and no browser history.
 */
export function BotsApp({
  children,
  accountMenu,
}: {
  children: ReactNode;
  /** Shown at the foot of the sidebar: the host's Keys, Account, Admin and Sign out. */
  accountMenu?: ReactNode;
}) {
  const { Link } = useChatAdapter();
  const { t } = useI18n();
  return (
    <div className="group/app flex min-h-0 flex-1 bg-background">
      <BotSidebar accountMenu={accountMenu} />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto max-md:group-has-[[data-bots-home]]/app:hidden">
        <nav className="sticky top-0 z-10 border-b bg-background px-2 py-1 md:hidden">
          <Link
            page={{ to: "bots" }}
            aria-label={t("bots.backToList")}
            title={t("bots.backToList")}
            className="inline-flex size-9 items-center justify-center rounded-md hover:bg-muted"
          >
            <ArrowLeftIcon className="size-5" />
          </Link>
        </nav>
        {children}
      </main>
    </div>
  );
}

/** `/bots` with no Bot open. */
export function BotsHomePage() {
  const { t } = useI18n();
  return (
    <p data-bots-home className="m-auto p-4 text-sm text-muted-foreground">
      {t("bots.pickABot")}
    </p>
  );
}
