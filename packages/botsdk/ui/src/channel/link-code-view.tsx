import type { LinkCode } from "@botsdk/client/bot/linked-identity";

import { useI18n } from "@botsdk/react/provider";

/**
 * A link code (spec #1044) as the user sees it: the 6 digits, when it expires, and a link per Bot
 * Channel account that opens a chat carrying it. `botId` narrows the links to one Bot's.
 */
export function LinkCodeView({ issued, botId }: { issued: LinkCode; botId?: string }) {
  const { t } = useI18n();
  const links = botId ? issued.links.filter((link) => link.botId === botId) : issued.links;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="text-xs text-muted-foreground">{t("settings.linkCodeHelp")}</p>
      <p aria-label={t("settings.getLinkCode")} className="font-mono text-lg tracking-widest">
        {issued.code}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("settings.linkCodeExpires", { time: issued.expiresAt.toLocaleTimeString() })}
      </p>
      {links.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settings.linkCodeNoBots")}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {links.map((link) => (
            <li key={`${link.botId}:${link.platform}`}>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary underline"
              >
                {t("settings.linkCodeOpen", {
                  bot: link.botName,
                  platform: t("bots.channelPlatform", { platform: link.platform }),
                })}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
