import type { ReactNode } from "react";

import { useI18n } from "../../../core/client/react/provider";
import { BotSidebar } from "./bot-sidebar";

/** The full-screen Bots app, in place of the assistant's shell: the Bots sidebar, then the page. */
export function BotsApp({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 bg-background">
      <BotSidebar />
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

/** `/bots` with no Bot open. */
export function BotsHomePage() {
  const { t } = useI18n();
  return <p className="m-auto p-4 text-sm text-muted-foreground">{t("bots.pickABot")}</p>;
}
