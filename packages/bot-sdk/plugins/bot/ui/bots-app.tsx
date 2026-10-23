import type { ReactNode } from "react";

import { useI18n } from "../../../core/client/react/provider";
import { BotSidebar } from "./bot-sidebar";

/** The full-screen Bots app, in place of the assistant's shell: the Bots sidebar, then the page. */
export function BotsApp({
  children,
  accountMenu,
}: {
  children: ReactNode;
  /** Shown at the foot of the sidebar: the host's Keys, Account, Admin and Sign out. */
  accountMenu?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 bg-background">
      <BotSidebar accountMenu={accountMenu} />
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">{children}</main>
    </div>
  );
}

/** `/bots` with no Bot open. */
export function BotsHomePage() {
  const { t } = useI18n();
  return <p className="m-auto p-4 text-sm text-muted-foreground">{t("bots.pickABot")}</p>;
}
