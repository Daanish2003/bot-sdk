import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useChatAdapter, useI18n } from "../../../core/client/react/provider";
import { BotAvatar } from "./bot-avatar";
import { NewBotDialog } from "./new-bot-dialog";

/** The Bots app's sidebar: the user's Bots, "+ New Bot", and a link back to the assistant. */
export function BotSidebar() {
  const { orpc, Link } = useChatAdapter();
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const bots = useQuery(orpc.bot.list.queryOptions());

  return (
    <aside
      aria-label={t("bots.app")}
      className="flex w-80 shrink-0 flex-col border-r bg-muted/40 max-md:w-64"
    >
      <div className="flex items-center justify-between gap-2 p-4">
        <Link
          page={{ to: "new" }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3" />
          {t("bots.backToAssistant")}
        </Link>
        <Button size="sm" className="rounded-full" onClick={() => setCreating(true)}>
          <PlusIcon />
          {t("bots.newBot")}
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {bots.data?.map((bot) => (
          <li key={bot.id}>
            <Link
              page={{ to: "bots", id: bot.id }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted"
              activeClassName="bg-muted"
            >
              <BotAvatar name={bot.name} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{bot.name}</span>
            </Link>
          </li>
        ))}
      </ul>
      {bots.data?.length === 0 && (
        <p className="px-4 pb-4 text-xs text-muted-foreground">{t("bots.noBots")}</p>
      )}
      <NewBotDialog open={creating} onOpenChange={setCreating} />
    </aside>
  );
}
