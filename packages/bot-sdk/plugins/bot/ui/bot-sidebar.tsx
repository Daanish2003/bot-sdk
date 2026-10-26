import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { dateFormat } from "../../../core/client/intl";
import { useChatAdapter, useI18n } from "../../../core/client/react/provider";
import { useSendingBotIds } from "../client/react/bot-turn";
import { BotAvatar } from "./bot-avatar";
import { NewBotDialog } from "./new-bot-dialog";

/** The Bots app's sidebar: the user's Bots, "+ New Bot", and the host's account menu at its foot. */
export function BotSidebar({ accountMenu }: { accountMenu?: ReactNode }) {
  const { orpc, Link } = useChatAdapter();
  const { t, locale } = useI18n();
  const sending = useSendingBotIds();
  const [creating, setCreating] = useState(false);
  // Kept fresh by the open Bot's change log (`useBotSync` invalidates it) and on window focus; it
  // isn't polled (ADR 0026).
  const bots = useQuery(orpc.bots.list.queryOptions());

  const working = (bot: { id: string; turnStatus: string | null }) =>
    sending.has(bot.id) || bot.turnStatus === "running";

  return (
    <aside
      aria-label={t("bots.app")}
      className="flex w-80 shrink-0 flex-col border-r bg-muted/40 max-md:w-64"
    >
      <div className="flex items-center justify-end gap-2 p-4">
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
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">{bot.name}</span>
                  {bot.lastMessage && (
                    <time
                      dateTime={bot.lastMessage.at.toISOString()}
                      className="shrink-0 text-xs text-muted-foreground"
                    >
                      {dateFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
                        bot.lastMessage.at,
                      )}
                    </time>
                  )}
                </span>
                {working(bot) ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {t("bots.working")}
                  </span>
                ) : (
                  bot.lastMessage && (
                    <span className="truncate text-xs text-muted-foreground">
                      {bot.lastMessage.text}
                    </span>
                  )
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {bots.data?.length === 0 && (
        <p className="px-4 pb-4 text-xs text-muted-foreground">{t("bots.noBots")}</p>
      )}
      {accountMenu && <div className="border-t p-3">{accountMenu}</div>}
      <NewBotDialog open={creating} onOpenChange={setCreating} />
    </aside>
  );
}
